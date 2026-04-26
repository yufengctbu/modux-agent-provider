import * as vscode from 'vscode'
import * as https from 'node:https'
import * as http from 'node:http'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek 适配器
//
// 通过 OpenAI 兼容的 HTTP API 调用 DeepSeek 模型。
// 端点：https://api.deepseek.com/chat/completions
// 鉴权：Authorization: Bearer <apiKey>
//
// 支持能力：
//   - 流式文本输出（SSE text/event-stream）
//   - 工具调用（tool_calls / function calling）：SSE 流内逐块累积后 yield
//   - 思考模式（thinking mode）的 reasoning_content 回传与降级
//
// 消息转换规则（vscode.LanguageModelChatMessage → OpenAI 格式）：
//   - User 消息中的 LanguageModelToolResultPart → 独立的 role:tool 消息
//   - Assistant 消息中的 LanguageModelToolCallPart → tool_calls 字段
//   - 文本部分 → content 字段
//
// 思考模式契约（详见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）：
//   - 两个 user 消息之间，若 assistant 进行了工具调用，则该 assistant 的
//     reasoning_content 必须在后续所有请求中回传给 API，否则 400
//   - 本适配器以 callId 指纹为 key 把 reasoning_content 缓存在内存中，下一轮
//     转换消息时回填到对应 assistant 上
//   - 缓存失败的兜底：检测到任意带 tool_calls 的 assistant 缺失 reasoning_content
//     时，对该请求显式 thinking:disabled，避开服务端校验，保留完整历史
// ─────────────────────────────────────────────────────────────────────────────

/** 估算 token 数的字符/token 比例 */
const CHARS_PER_TOKEN = 4

// ── 思考块（reasoning_content）UI 渲染包装 ─────────────────────────────────────
//
// 把 reasoning_content 流式渲染为 markdown <details> 折叠块，在 VS Code Chat 面板
// 中显示为"💭 思考"区域。两侧夹 HTML 注释 sentinel：
//   - 渲染时不可见，对 UI 透明
//   - toDeepSeekMessages 据此把整段思考块从历史 content 中剥离，避免与
//     reasoning_content 字段重复发送给 API
//
// 注：DeepSeek 文档明确，reasoning_content 须通过同名字段（非 content）回传，
// 详见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

const REASONING_OPEN_MARKER =
  '\n\n<!--MODUX_REASONING_START--><details open><summary>💭 思考</summary>\n\n'
const REASONING_CLOSE_MARKER = '\n\n</details><!--MODUX_REASONING_END-->\n\n'

/** 用于从 assistant 文本中剔除思考块的正则；非贪婪匹配，吞噬两侧空白 */
const REASONING_BLOCK_PATTERN =
  /\s*<!--MODUX_REASONING_START-->[\s\S]*?<!--MODUX_REASONING_END-->\s*/g

/** DeepSeek 适配器配置（来自 config.llms 中 type=deepseek 的条目） */
interface DeepSeekConfig {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl: string
  /** 是否验证 TLS 证书，默认 true；企业代理/自签证书环境可设为 false */
  readonly rejectUnauthorized: boolean
}

// ── OpenAI 兼容消息格式 ────────────────────────────────────────────────────────

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** thinking 模式下的 CoT 内容，多轮对话时须原样回传 */
  reasoning_content?: string
  tool_calls?: DeepSeekToolCall[]
  tool_call_id?: string
}

interface DeepSeekToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface DeepSeekTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

// ── SSE 流类型 ─────────────────────────────────────────────────────────────────

interface SseChunk {
  choices?: Array<{
    delta?: {
      content?: string
      /** thinking 模式下 CoT 增量内容 */
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
}

/** 跨 SSE 块累积中的工具调用 */
interface PartialToolCall {
  id: string
  name: string
  args: string
}

// ── 适配器 ────────────────────────────────────────────────────────────────────

class DeepSeekAdapter implements LlmAdapter {
  readonly type = 'deepseek'

  /**
   * reasoning_content 缓存：key = assistant 消息指纹
   * （工具调用时用 callId 列表，纯文本时用内容文本）
   * value = DeepSeek 返回的 reasoning_content，下一轮须原样回传
   *
   * 缓存生命周期：与 adapter 实例同寿（singleton，跨 chat 调用持续）。
   * 扩展重载、新会话从模型下拉选入等场景下缓存可能为空，由 chat() 中的
   * thinking:disabled 兜底逻辑处理。
   */
  private readonly reasoningCache = new Map<string, string>()

  constructor(private readonly cfg: DeepSeekConfig) {}

  async getChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
    return [
      {
        id: 'modux-agent-deepseek',
        name: 'modux-agent-deepseek',
        family: 'modux-agent-deepseek',
        version: '1.0.0',
        tooltip: 'Modux Agent DeepSeek — 由 DeepSeek 驱动的智能编码助手',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
    ]
  }

  async *chat(req: LlmChatRequest): AsyncIterable<vscode.LanguageModelResponsePart> {
    if (!this.cfg.apiKey) {
      throw new Error('DeepSeek 适配器未配置 apiKey，请在 config.json 中填写 deepseek.apiKey')
    }

    const { messages, hasMissingReasoning } = this.toDeepSeekMessages(req.messages)
    const tools = req.tools.length > 0 ? toDeepSeekTools(req.tools) : undefined

    // 当历史中存在带 tool_calls 但缺失 reasoning_content 的 assistant 消息时，
    // 显式关闭思考模式，让服务端跳过 reasoning_content 必填校验，避免 400。
    // 文档参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      ...(tools ? { tools } : {}),
      stream: true,
      ...(hasMissingReasoning ? { thinking: { type: 'disabled' } } : {}),
    })

    log(
      `[DeepSeek Adapter] 发起请求：model=${this.cfg.model}，messages=${messages.length}` +
        (hasMissingReasoning ? '，thinking=disabled（reasoning_content 缓存缺失，降级）' : ''),
    )

    let incoming: http.IncomingMessage
    let destroyRequest: () => void
    try {
      ;({ incoming, destroyRequest } = await this.doRequest(body, req.signal))
    } catch (err) {
      if (req.signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      log(`[DeepSeek Adapter] 网络请求失败：${msg}`)
      throw new Error(`DeepSeek 请求失败：${msg}`)
    }

    if (incoming.statusCode !== 200) {
      const text = await readIncomingAll(incoming)
      log(`[DeepSeek Adapter] HTTP 错误 ${incoming.statusCode}：${text}`)
      throw new Error(`DeepSeek API 错误 HTTP ${incoming.statusCode}：${text}`)
    }

    // 累积跨 SSE 块的工具调用，流结束后统一 yield
    const partialCalls = new Map<number, PartialToolCall>()
    // 累积 reasoning_content 和文本内容（用于缓存指纹计算）
    const reasoningOut = { content: '' }
    const textOut: string[] = []

    yield* this.readSseStream(
      incoming,
      req.signal,
      destroyRequest,
      partialCalls,
      reasoningOut,
      textOut,
    )

    // 流结束后，将累积的工具调用 yield 出去（按 index 升序）
    const sortedCalls = [...partialCalls.entries()].sort(([a], [b]) => a - b)
    for (const [, tc] of sortedCalls) {
      let input: unknown = {}
      try {
        input = tc.args ? (JSON.parse(tc.args) as unknown) : {}
      } catch {
        // arguments 解析失败时传空对象，让工具侧报错而非崩溃
        input = {}
      }
      log(`[DeepSeek Adapter] 工具调用：${tc.name}（callId=${tc.id}）`)
      yield new vscode.LanguageModelToolCallPart(tc.id, tc.name, (input ?? {}) as object)
    }

    // 缓存本轮 reasoning_content（含空串），供下一轮构建历史消息时注回 assistant。
    // 即便为空字符串也写入：避免下一轮按 truthy 判断把"思考为空"误识为"缓存缺失"，
    // 从而触发不必要的 thinking:disabled 级联降级。
    const fingerprint =
      sortedCalls.length > 0 ? sortedCalls.map(([, tc]) => tc.id).join(',') : textOut.join('')
    if (fingerprint) {
      this.reasoningCache.set(fingerprint, reasoningOut.content)
      if (reasoningOut.content) {
        log(`[DeepSeek Adapter] 缓存 reasoning_content，长度=${reasoningOut.content.length}`)
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  /**
   * 使用 Node.js https 模块发起请求，绕过 undici 的 TLS 限制
   * 支持企业代理/自签证书环境（rejectUnauthorized: false）
   */
  private doRequest(
    body: string,
    signal: AbortSignal,
  ): Promise<{ incoming: http.IncomingMessage; destroyRequest: () => void }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.cfg.baseUrl}/chat/completions`)
      const bodyBuf = Buffer.from(body, 'utf-8')

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Length': bodyBuf.length,
        },
        rejectUnauthorized: this.cfg.rejectUnauthorized,
      }

      const req = https.request(options, (res) => {
        resolve({ incoming: res, destroyRequest: () => req.destroy() })
      })

      req.on('error', (err) => {
        if (signal.aborted) return // abort 后的 destroy 错误忽略
        reject(err)
      })

      // 取消信号：销毁底层 socket
      signal.addEventListener('abort', () => req.destroy(), { once: true })

      req.write(bodyBuf)
      req.end()
    })
  }

  /**
   * 解析 SSE 流：实时 yield 文本片段，同时将工具调用块累积到 partialCalls
   *
   * 思考流处理（v2）：reasoning_content 实时 yield 为 TextPart，前后用
   * REASONING_OPEN/CLOSE_MARKER 夹紧，UI 渲染为 <details> 折叠块；
   * toDeepSeekMessages 在下一轮序列化时按 marker 把整段思考块从 content 剥离。
   *
   * @param reasoningOut 输出参数：累积的 reasoning_content（用于缓存原文）
   * @param textOut      输出参数：累积的"非思考"文本片段（用于指纹计算）
   */
  private async *readSseStream(
    stream: http.IncomingMessage,
    signal: AbortSignal,
    destroyRequest: () => void,
    partialCalls: Map<number, PartialToolCall>,
    reasoningOut: { content: string },
    textOut: string[],
  ): AsyncIterable<vscode.LanguageModelTextPart> {
    const decoder = new TextDecoder()
    let leftover = '' // 跨 chunk 的不完整行缓存

    /** 思考块开闭状态。一次响应内只有一段思考块（最多一对 open/close） */
    let reasoningOpened = false
    let reasoningClosed = false

    try {
      for await (const raw of stream) {
        if (signal.aborted) return

        const text = leftover + decoder.decode(raw as Buffer, { stream: true })
        const lines = text.split('\n')
        leftover = lines.pop() ?? '' // 最后一段可能不完整，留给下次处理

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return

          let sseChunk: SseChunk
          try {
            sseChunk = JSON.parse(data) as SseChunk
          } catch {
            continue // 忽略非 JSON 行
          }

          const delta = sseChunk.choices?.[0]?.delta
          if (!delta) continue

          // thinking 模式 CoT 内容：累积原文 + 流式 yield 给 UI（首次出现时
          // 先 yield 开放 marker；非思考片段到来时再 yield 关闭 marker）
          if (delta.reasoning_content) {
            if (!reasoningOpened) {
              reasoningOpened = true
              yield new vscode.LanguageModelTextPart(REASONING_OPEN_MARKER)
            }
            reasoningOut.content += delta.reasoning_content
            yield new vscode.LanguageModelTextPart(delta.reasoning_content)
          }

          // 即将出现非思考内容（content / tool_calls）时关闭思考块
          const hasNonReasoning = !!delta.content || !!delta.tool_calls?.length
          if (hasNonReasoning && reasoningOpened && !reasoningClosed) {
            reasoningClosed = true
            yield new vscode.LanguageModelTextPart(REASONING_CLOSE_MARKER)
          }

          // 文本内容：实时 yield，同时写入 textOut 用于指纹计算
          if (delta.content) {
            textOut.push(delta.content)
            yield new vscode.LanguageModelTextPart(delta.content)
          }

          // 工具调用块：按 index 累积
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!partialCalls.has(tc.index)) {
                partialCalls.set(tc.index, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: '',
                })
              }
              const acc = partialCalls.get(tc.index)!
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.args += tc.function.arguments
            }
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return // 取消后的 socket 错误忽略
      throw err
    } finally {
      // 流结束时若思考块仍开着（例如只有思考没有正文也没有工具调用），补一次关闭
      if (reasoningOpened && !reasoningClosed) {
        yield new vscode.LanguageModelTextPart(REASONING_CLOSE_MARKER)
      }
      if (signal.aborted) destroyRequest()
    }
  }

  // ── 消息序列化 ────────────────────────────────────────────────────────────────

  /**
   * 将 vscode.LanguageModelChatMessage[] 转换为 DeepSeek/OpenAI 消息格式
   *
   * 转换规则：
   *   - Assistant 含工具调用 → tool_calls 字段，content 可为 null
   *   - User 含工具结果       → 展开为多条 role:tool 消息（每条对应一个 callId）
   *   - 纯文本消息            → content 字段
   *   - reasoning_content    → 从缓存中按指纹查找后注入（thinking 模式多轮必需）
   *   - 思考块 (UI 用 marker) → 从 content 中按 REASONING_BLOCK_PATTERN 整段剥离
   *
   * 容错策略：
   *   - 内容 part 同时支持 class 实例（instanceof）和 plain object（鸭子类型）
   *     避免 VS Code IPC 序列化后 instanceof 失效导致的类型误判
   *   - 缓存判定使用 Map.has()（区分"未命中"与"命中但为空"）：
   *       · has=true：按 has 命中处理，回填 reasoning_content（哪怕为空字符串），
   *                   DeepSeek 文档允许空串作为合法 reasoning_content
   *       · has=false：标记 hasMissingReasoning，由 chat() 切到 thinking:disabled
   *
   * @returns messages              转换后的 DeepSeek 消息列表
   * @returns hasMissingReasoning   是否存在缺失 reasoning_content 的 tool_calls assistant
   */
  private toDeepSeekMessages(messages: readonly vscode.LanguageModelChatMessage[]): {
    messages: DeepSeekMessage[]
    hasMissingReasoning: boolean
  } {
    const result: DeepSeekMessage[] = []
    let hasMissingReasoning = false

    for (const msg of messages) {
      const rawContent = msg.content as unknown[]
      // VS Code 有时将 string 内容直接存为数组外层，做兼容处理
      const parts: unknown[] = Array.isArray(rawContent) ? rawContent : [rawContent]
      const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant

      if (isAssistant) {
        const textValues: string[] = []
        const toolCallInfos: Array<{ callId: string; name: string; input: unknown }> = []

        for (const p of parts) {
          const tc = extractToolCall(p)
          if (tc) {
            toolCallInfos.push(tc)
            continue
          }
          const tv = extractText(p)
          if (tv !== undefined) textValues.push(tv)
        }

        // 把 UI 渲染用的思考块从 content 中剥离，避免和 reasoning_content 字段重复
        const cleanText = textValues.join('').replace(REASONING_BLOCK_PATTERN, '')

        // 按指纹从缓存中查找 reasoning_content（用清洗后的文本作 key，与 chat()
        // 写入端保持一致——写入端 textOut 也只累积 delta.content，不含 marker）
        const fingerprint =
          toolCallInfos.length > 0
            ? toolCallInfos.map((tc) => tc.callId).join(',')
            : cleanText
        const cacheHit = fingerprint ? this.reasoningCache.has(fingerprint) : false
        const reasoningContent = cacheHit ? (this.reasoningCache.get(fingerprint) ?? '') : undefined

        // 只有真正"未命中"才触发降级；空字符串视为命中（DeepSeek 允许空串）
        if (toolCallInfos.length > 0 && !cacheHit) {
          hasMissingReasoning = true
        }

        if (toolCallInfos.length > 0) {
          result.push({
            role: 'assistant',
            content: cleanText.length > 0 ? cleanText : null,
            ...(cacheHit ? { reasoning_content: reasoningContent } : {}),
            tool_calls: toolCallInfos.map((tc) => ({
              id: tc.callId,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
              },
            })),
          })
        } else {
          result.push({
            role: 'assistant',
            content: cleanText,
            ...(cacheHit ? { reasoning_content: reasoningContent } : {}),
          })
        }
      } else {
        // User 角色：先展开工具结果为独立 tool 消息，再追加文本
        const toolResultMsgs: DeepSeekMessage[] = []
        const userTexts: string[] = []

        for (const p of parts) {
          const tr = extractToolResult(p)
          if (tr) {
            const resultText = tr.content.map((inner) => extractText(inner) ?? '').join('')
            toolResultMsgs.push({ role: 'tool', tool_call_id: tr.callId, content: resultText })
            continue
          }
          const tv = extractText(p)
          if (tv !== undefined) userTexts.push(tv)
        }

        result.push(...toolResultMsgs)
        if (userTexts.length > 0) {
          result.push({ role: 'user', content: userTexts.join('') })
        }
      }
    }

    return { messages: result, hasMissingReasoning }
  }
}

// ── 内容 Part 类型提取（duck typing，兼容 class 实例和 plain object） ───────────────

/**
 * 提取文本内容
 * 兼容 LanguageModelTextPart 实例和 VS Code IPC 反序列化后的 plain object
 */
function extractText(p: unknown): string | undefined {
  if (p instanceof vscode.LanguageModelTextPart) return p.value
  const obj = p as Record<string, unknown>
  // plain object：有 value:string 且没有 callId（避免与工具类 part 混淆）
  if (typeof obj?.value === 'string' && !('callId' in obj)) return obj.value
  // 直接传入了字符串
  if (typeof p === 'string') return p
  return undefined
}

/**
 * 提取工具调用信息
 * 兼容 LanguageModelToolCallPart 实例和 plain object
 */
function extractToolCall(p: unknown): { callId: string; name: string; input: unknown } | undefined {
  if (p instanceof vscode.LanguageModelToolCallPart) {
    return { callId: p.callId, name: p.name, input: p.input }
  }
  const obj = p as Record<string, unknown>
  if (
    typeof obj?.callId === 'string' &&
    typeof obj?.name === 'string' &&
    !Array.isArray(obj?.content)
  ) {
    return { callId: obj.callId, name: obj.name, input: obj.input }
  }
  return undefined
}

/**
 * 提取工具结果信息
 * 兼容 LanguageModelToolResultPart 实例和 plain object
 */
function extractToolResult(p: unknown): { callId: string; content: unknown[] } | undefined {
  if (p instanceof vscode.LanguageModelToolResultPart) {
    return { callId: p.callId, content: p.content as unknown[] }
  }
  const obj = p as Record<string, unknown>
  if (typeof obj?.callId === 'string' && Array.isArray(obj?.content)) {
    return { callId: obj.callId, content: obj.content }
  }
  return undefined
}

/**
 * 将 Node.js IncomingMessage 的全部数据读取为字符串
 * 用于非流式错误响应体的读取
 */
function readIncomingAll(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    stream.on('error', reject)
  })
}

/**
 * 将 vscode.LanguageModelChatTool[] 转换为 DeepSeek/OpenAI function calling 格式
 */
function toDeepSeekTools(tools: readonly vscode.LanguageModelChatTool[]): DeepSeekTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

// ── 工厂自注册 ────────────────────────────────────────────────────────────────

const factory: LlmAdapterFactory = {
  type: 'deepseek',
  create(cfg) {
    const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    const model = typeof cfg.model === 'string' ? cfg.model : 'deepseek-v4-flash'
    const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : 'https://api.deepseek.com'
    const rejectUnauthorized = cfg.rejectUnauthorized !== false // 默认 true
    return new DeepSeekAdapter({ apiKey, model, baseUrl, rejectUnauthorized })
  },
}

registerAdapterFactory(factory)
