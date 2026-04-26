import * as vscode from 'vscode'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Modux Backend 适配器
//
// 将聊天请求转发到用户自有的后端（OpenAI-compatible HTTP 接口）。
// 迁移自原 src/provider/LmProvider.ts 中的 forwardToBackend 系列方法。
//
// 响应兼容：
//   - text/event-stream：按 OpenAI SSE 格式解析，同时支持
//     { content } 和 { choices[0].delta.content } 两种 delta 结构
//   - application/json：依次尝试 content → message → JSON.stringify
//
// 已知约束：本适配器不解析后端返回的工具调用，仅 yield TextPart。
// 当其作为激活 Adapter 且被 Agent Loop 使用时，Loop 会在首轮因无
// ToolCallPart 而自然结束。
// ─────────────────────────────────────────────────────────────────────────────

/** 估算 token 数的字符/token 比例 */
const CHARS_PER_TOKEN = 4

/** 自有后端配置（来自 config.llms 中 type=moduxBackend 的条目） */
interface ModuxBackendConfig {
  readonly url: string
  readonly forwardTools: boolean
}

// ── 后端请求 / 响应类型 ───────────────────────────────────────────────────────

/** 发往后端的单条消息（简化 OpenAI 格式） */
interface BackendMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 发往后端的请求体 */
interface BackendRequestBody {
  messages: BackendMessage[]
  tools?: vscode.LanguageModelChatTool[]
}

/** OpenAI SSE delta（兼容两种格式） */
interface SseDelta {
  content?: string
  choices?: Array<{ delta?: { content?: string } }>
}

// ── 适配器 ────────────────────────────────────────────────────────────────────

class ModuxBackendAdapter implements LlmAdapter {
  readonly type = 'moduxBackend'

  constructor(private readonly cfg: ModuxBackendConfig) {}

  async getChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
    return [
      {
        id: 'modux-agent',
        name: 'modux-agent',
        family: 'modux-agent',
        version: '1.0.0',
        tooltip: 'Modux Agent — 你的智能编码助手',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
    ]
  }

  async *chat(req: LlmChatRequest): AsyncIterable<vscode.LanguageModelResponsePart> {
    for await (const text of this.streamBackendText(req)) {
      yield new vscode.LanguageModelTextPart(text)
    }
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  // ── 核心：向后端 POST，按响应类型分流 ───────────────────────────────────────

  /**
   * 向后端发起请求，yield 文本片段（未包装为 Part）
   * 返回 AsyncIterable<string>，由 chat() 包成 TextPart
   */
  private async *streamBackendText(req: LlmChatRequest): AsyncIterable<string> {
    const body: BackendRequestBody = {
      messages: req.messages.map((m) => ({
        role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
        content: serializeMessageContent(m.content as vscode.LanguageModelInputPart[]),
      })),
    }

    if (this.cfg.forwardTools && req.tools.length > 0) {
      body.tools = [...req.tools]
    }

    log(`[Backend Adapter] 转发至：${this.cfg.url}`)

    let res: Response
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      })
    } catch (err) {
      // AbortError 表示用户取消，静默终止（不抛出，符合 LlmAdapter 取消语义）
      if (err instanceof Error && err.name === 'AbortError') return
      const msg = err instanceof Error ? err.message : String(err)
      log(`[Backend Adapter] 网络请求失败：${msg}`)
      yield `**请求失败**：${msg}`
      return
    }

    if (!res.ok) {
      const text = await res.text()
      log(`[Backend Adapter] 后端错误 HTTP ${res.status}：${text}`)
      yield `**后端错误** HTTP ${res.status}：${text}`
      return
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      yield* this.readSseStream(res, req.signal)
    } else {
      yield* this.readJsonResponse(res)
    }
  }

  /**
   * 解析 SSE 流式响应
   *
   * 兼容两种 delta 格式：
   *   - 自定义：{ content: "..." }
   *   - OpenAI：{ choices: [{ delta: { content: "..." } }] }
   */
  private async *readSseStream(res: Response, signal: AbortSignal): AsyncIterable<string> {
    if (!res.body) {
      log('[Backend Adapter] SSE 响应体为空')
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break

        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return

          try {
            const chunk = JSON.parse(data) as SseDelta
            const content = chunk.content ?? chunk.choices?.[0]?.delta?.content
            if (content) yield content
          } catch {
            // 忽略非 JSON 行（空行、注释行等）
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {
        // reader 可能已被上游关闭，忽略二次关闭错误
      })
    }
  }

  /**
   * 解析普通 JSON 响应
   * 依次尝试 content → message → JSON.stringify 三个字段
   */
  private async *readJsonResponse(res: Response): AsyncIterable<string> {
    const json = (await res.json()) as Record<string, unknown>
    const text =
      typeof json.content === 'string'
        ? json.content
        : typeof json.message === 'string'
          ? json.message
          : JSON.stringify(json)
    yield text
  }
}

// ── 消息内容序列化 ────────────────────────────────────────────────────────────

/**
 * 将 LanguageModelChatMessage 的 content 序列化为纯文本字符串
 *
 * 序列化策略：
 *   - LanguageModelTextPart     → 直接取 value
 *   - LanguageModelToolCallPart → "[Tool Call: name(input)]" 占位符
 *   - LanguageModelToolResultPart → "[Tool Result: content]" 占位符
 *   - 其他类型                   → 忽略
 */
function serializeMessageContent(content: readonly vscode.LanguageModelInputPart[]): string {
  const parts: string[] = []

  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value)
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      const inputStr = typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
      parts.push(`[Tool Call: ${part.name}(${inputStr})]`)
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const resultText = part.content
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
        .map((p) => p.value)
        .join('')
      parts.push(`[Tool Result: ${resultText}]`)
    }
  }

  return parts.join('\n')
}

// ── 工厂自注册 ────────────────────────────────────────────────────────────────

const factory: LlmAdapterFactory = {
  type: 'moduxBackend',
  create(cfg) {
    const url = typeof cfg.url === 'string' ? cfg.url : ''
    if (!url) {
      throw new Error('moduxBackend 适配器缺少必填字段：url')
    }
    const forwardTools = cfg.forwardTools === true
    return new ModuxBackendAdapter({ url, forwardTools })
  },
}

registerAdapterFactory(factory)
