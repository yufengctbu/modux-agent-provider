import * as vscode from 'vscode'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'
import { countTokensByType } from '../../token'

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

/** 自有后端配置（来自 config.llms 中 type=moduxBackend 的条目） */
interface ModuxBackendConfig {
  readonly url: string
  readonly forwardTools: boolean
  /**
   * 是否把图像 DataPart 序列化为 OpenAI 兼容的 image_url(data URL) 格式
   * 转发给后端。
   *
   * true  → message.content 改为多模态数组 [{type:'text'}, {type:'image_url'}]
   * false → 图像位置保留一行 "[image: ...]" 文本占位（默认）
   *
   * 用户后端不支持视觉时保持默认 false，避免 base64 数据膨胀和后端 4xx。
   */
  readonly forwardImages: boolean
}

// ── 后端请求 / 响应类型 ───────────────────────────────────────────────────────

/** OpenAI 多模态 content part（仅 forwardImages=true 时使用） */
type BackendContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 发往后端的单条消息（OpenAI 兼容） */
interface BackendMessage {
  role: 'user' | 'assistant'
  content: string | BackendContentPart[]
}

/** 发往后端的请求体 */
interface BackendRequestBody {
  messages: BackendMessage[]
  tools?: vscode.LanguageModelChatTool[]
  /** tool_choice 映射自 req.toolMode，仅当 tools 存在且有 toolMode 时设置 */
  tool_choice?: 'required' | 'auto'
}

/** OpenAI SSE delta（兼容两种格式） */
interface SseDelta {
  content?: string
  choices?: Array<{ delta?: { content?: string } }>
}

// ── 适配器 ────────────────────────────────────────────────────────────────────

class ModuxBackendAdapter implements LlmAdapter {
  readonly type = 'moduxBackend'
  /** 自有后端保守估算的上下文窗口，实际值由后端模型决定 */
  readonly contextWindowSize = 16_000

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
    return countTokensByType(this.type, text)
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
        content: this.cfg.forwardImages
          ? serializeMessageContentMultimodal(m.content as vscode.LanguageModelInputPart[])
          : serializeMessageContent(m.content as vscode.LanguageModelInputPart[]),
      })),
    }

    if (this.cfg.forwardTools && req.tools.length > 0) {
      body.tools = [...req.tools]
      // toolMode → tool_choice 映射（对齐 DeepSeek/Copilot 的行为）
      if (req.toolMode === vscode.LanguageModelChatToolMode.Required) {
        body.tool_choice = 'required'
      }
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
      // 工具结果：拼接文本片段；图像片段降级为占位
      const innerChunks: string[] = []
      for (const inner of part.content) {
        if (inner instanceof vscode.LanguageModelTextPart) {
          innerChunks.push(inner.value)
        } else if (inner instanceof vscode.LanguageModelDataPart) {
          innerChunks.push(`[image: ${inner.mimeType}, ${inner.data.byteLength} bytes]`)
        }
      }
      parts.push(`[Tool Result: ${innerChunks.join('')}]`)
    } else if (part instanceof vscode.LanguageModelDataPart) {
      // 顶层 DataPart：罕见但合法（用户消息直接附图），降级为占位
      parts.push(`[image: ${part.mimeType}, ${part.data.byteLength} bytes]`)
    }
  }

  return parts.join('\n')
}

/**
 * 序列化消息内容为 OpenAI 多模态格式（forwardImages=true 时使用）
 *
 * 仅当消息中真的包含图像时返回数组；否则降级为 string，
 * 避免不必要地把后端切到多模态解析路径。
 *
 * 工具调用 / 工具结果一律降级为文本占位（保持与后端的简单契约）。
 */
function serializeMessageContentMultimodal(
  content: readonly vscode.LanguageModelInputPart[],
): string | BackendContentPart[] {
  const out: BackendContentPart[] = []
  let hasImage = false

  const pushText = (text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    // 相邻文本合并，避免数组膨胀
    if (last && last.type === 'text') {
      last.text += text
    } else {
      out.push({ type: 'text', text })
    }
  }

  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      pushText(part.value)
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      const inputStr = typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
      pushText(`\n[Tool Call: ${part.name}(${inputStr})]`)
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const innerChunks: string[] = []
      for (const inner of part.content) {
        if (inner instanceof vscode.LanguageModelTextPart) {
          innerChunks.push(inner.value)
        } else if (inner instanceof vscode.LanguageModelDataPart) {
          if (inner.mimeType.startsWith('image/')) {
            // 工具内嵌图像：直接以 image_url 形式回传
            pushText(`\n[Tool Result: ${innerChunks.join('')}]\n`)
            innerChunks.length = 0
            out.push({
              type: 'image_url',
              image_url: { url: bufferToDataUrl(inner.data, inner.mimeType) },
            })
            hasImage = true
          }
        }
      }
      if (innerChunks.length > 0) {
        pushText(`\n[Tool Result: ${innerChunks.join('')}]`)
      }
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (part.mimeType.startsWith('image/')) {
        out.push({
          type: 'image_url',
          image_url: { url: bufferToDataUrl(part.data, part.mimeType) },
        })
        hasImage = true
      }
    }
  }

  if (!hasImage) {
    return out.map((p) => (p.type === 'text' ? p.text : '')).join('')
  }
  return out
}

/**
 * 把图像字节编码为 data URL（OpenAI 多模态规范）
 *
 * base64 让数据膨胀 ~33%，建议在源头（imageReader.maxBytes）做大小护栏。
 */
function bufferToDataUrl(data: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`
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
    const forwardImages = cfg.forwardImages === true // 默认 false（用户后端通常不支持视觉）
    return new ModuxBackendAdapter({ url, forwardTools, forwardImages })
  },
}

registerAdapterFactory(factory)
