import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'

// ─────────────────────────────────────────────────────────────────────────────
// modux-agent Language Model Provider（Phase 4）
//
// 实现 vscode.LanguageModelChatProvider 接口，使 modux-agent 出现在
// Copilot Chat 的模型下拉列表中。
//
// 核心改进（相比 Phase 1）：
//   1. AbortController：通过 token.onCancellationRequested 即时中止 fetch
//   2. 完整 Part 序列化：TextPart / ToolCallPart / ToolResultPart 全部序列化
//   3. OpenAI-compatible SSE：同时支持 { content } 和 { choices[0].delta.content } 格式
//   4. 工具转发：config.backend.forwardTools === true 时将 options.tools 发给后端
// ─────────────────────────────────────────────────────────────────────────────

// ── 类型定义（后端请求格式） ──────────────────────────────────────────────────

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

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 估算 token 数的字符/token 比例（4 字符 ≈ 1 token，粗略公式） */
const CHARS_PER_TOKEN = 4

// ── Provider 实现 ─────────────────────────────────────────────────────────────

/**
 * modux-agent LM Provider
 *
 * 当 backend.enabled = false 时返回占位提示；
 * 当 backend.enabled = true 时将消息转发至 backend.url，
 * 支持 SSE 流式和普通 JSON 两种响应格式。
 */
export class ModuxModelProvider implements vscode.LanguageModelChatProvider {
  /**
   * 返回本 provider 提供的模型元数据
   * VS Code 据此在模型选择器中展示 "Modux Agent"
   */
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
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

  /**
   * 处理聊天请求
   *
   * @param model    用户选中的模型信息
   * @param messages 完整对话上下文（历史 + 当前输入）
   * @param options  请求选项（工具列表等）
   * @param progress 流式输出通道
   * @param token    取消令牌
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { enabled, url } = config.backend
    log(
      `[LM Provider] 请求：model=${model.id}，messages=${messages.length}，后端转发=${enabled}`,
    )

    if (!enabled) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '（modux-agent 后端转发未启用，请将 config.json 中的 backend.enabled 设为 true 后重新构建）',
        ),
      )
      return
    }

    // ── AbortController：支持 token 取消即时中止 fetch ──────────────────────
    const abortController = new AbortController()
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort())

    try {
      await this.forwardToBackend(messages, options, url, progress, abortController.signal)
    } finally {
      cancelDisposable.dispose()
    }
  }

  /**
   * 估算 token 数量（粗略公式：4 字符 ≈ 1 token）
   * VS Code 在发送前用此值做 token 预算检查
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const str = typeof text === 'string' ? text : JSON.stringify(text)
    return Math.ceil(str.length / CHARS_PER_TOKEN)
  }

  // ── 私有方法 ───────────────────────────────────────────────────────────────

  /**
   * 将消息序列化后 POST 到后端，处理 SSE 和 JSON 两种响应格式
   */
  private async forwardToBackend(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    url: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    signal: AbortSignal,
  ): Promise<void> {
    const body: BackendRequestBody = {
      messages: messages.map((m) => ({
        role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
        content: serializeMessageContent(m.content),
      })),
    }

    // 按配置决定是否将工具声明转发给后端
    if (config.backend.forwardTools && options.tools?.length) {
      body.tools = [...options.tools]
    }

    log(`[LM Provider] 转发至：${url}`)

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      // AbortError 表示用户取消，静默处理；其他错误正常报告
      if (err instanceof Error && err.name === 'AbortError') return
      const msg = err instanceof Error ? err.message : String(err)
      log(`[LM Provider] 网络请求失败：${msg}`)
      progress.report(new vscode.LanguageModelTextPart(`**请求失败**：${msg}`))
      return
    }

    if (!res.ok) {
      const text = await res.text()
      log(`[LM Provider] 后端错误 HTTP ${res.status}：${text}`)
      progress.report(new vscode.LanguageModelTextPart(`**后端错误** HTTP ${res.status}：${text}`))
      return
    }

    const contentType = res.headers.get('content-type') ?? ''

    if (contentType.includes('text/event-stream')) {
      await this.handleSseStream(res, progress, signal)
    } else {
      await this.handleJsonResponse(res, progress)
    }
  }

  /**
   * 处理 SSE 流式响应
   *
   * 同时兼容两种 delta 格式：
   *   - 自定义格式：{ content: "..." }
   *   - OpenAI 格式：{ choices: [{ delta: { content: "..." } }] }
   */
  private async handleSseStream(
    res: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!res.body) {
      log('[LM Provider] SSE 响应体为空')
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
            // 兼容两种格式
            const content =
              chunk.content ?? chunk.choices?.[0]?.delta?.content
            if (content) {
              progress.report(new vscode.LanguageModelTextPart(content))
            }
          } catch {
            // 忽略非 JSON 行（空行、注释行等）
          }
        }
      }
    } finally {
      reader.cancel()
    }
  }

  /**
   * 处理普通 JSON 响应
   * 依次尝试 content → message → JSON.stringify 三个字段
   */
  private async handleJsonResponse(
    res: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<void> {
    const json = (await res.json()) as Record<string, unknown>
    const text =
      typeof json.content === 'string'
        ? json.content
        : typeof json.message === 'string'
          ? json.message
          : JSON.stringify(json)
    progress.report(new vscode.LanguageModelTextPart(text))
  }
}

// ── 消息内容序列化 ─────────────────────────────────────────────────────────────

/**
 * 将 LanguageModelChatRequestMessage 的 content 序列化为纯文本字符串
 *
 * 序列化策略：
 *   - LanguageModelTextPart     → 直接取 value
 *   - LanguageModelToolCallPart → "[Tool Call: name(input)]" 占位符
 *   - LanguageModelToolResultPart → "[Tool Result: content]" 占位符
 *   - 其他类型                 → 忽略（对应 Claude Code serializeContent 的 default 分支）
 */
function serializeMessageContent(
  content: readonly vscode.LanguageModelChatMessageContentPart[],
): string {
  const parts: string[] = []

  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value)
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      const inputStr =
        typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
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
