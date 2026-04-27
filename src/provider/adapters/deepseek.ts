import * as vscode from 'vscode'
import * as https from 'node:https'
import * as http from 'node:http'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'
import { estimateTokenCount } from '../../shared/tokenEstimator'

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
//     reasoning_content **必须** 在后续所有请求中回传给 API，否则 400
//   - 注意：thinking:{type:'disabled'} 只控制本轮输出是否包含 reasoning_content，
//     **无法绕过服务端对历史消息合法性的校验**——历史里旧的 tool_calls assistant
//     仍要求带 reasoning_content 字段
//   - 文档说"未进行工具调用的中间 assistant 的 reasoning_content 会被忽略"，
//     但实测在 V4 上只要上下文里夹着 thinking 模式产生的消息，整段会被当作
//     "思考模式上下文"做完整性校验，缺字段也可能触发 400。所以这里采取**最保守**
//     的策略：**所有** assistant 消息都强制带非空 reasoning_content（含纯文本）。
//
// reasoning_content 三层来源（优先级递减）：
//   1. 历史消息中携带的 LanguageModelThinkingPart（VS Code/Cursor 多轮保留）
//   2. 内存 reasoningCache（本进程生命周期内按 callId 指纹缓存）
//   3. MISSING_REASONING_PLACEHOLDER 兜底（扩展重启或会话跨边界等场景）
// 始终保证**任何** assistant 的 reasoning_content 字段非空，彻底避开 400 校验。
// ─────────────────────────────────────────────────────────────────────────────

// ── 思考块（reasoning_content）UI 渲染 ─────────────────────────────────────────
//
// 通过 VS Code proposed API LanguageModelThinkingPart 把 reasoning_content 流式
// 回传给 Chat 面板（VS Code / Cursor），UI 渲染为"正在推理"灰色状态条，与
// Copilot 官方一致。模式参考 vscode-copilot-chat languageModelAccess.ts：
//   - 出现 reasoning 增量：progress.report(new LanguageModelThinkingPart(text, id, meta))
//   - 转入正文/工具调用时：progress.report(new LanguageModelThinkingPart('', '', { vscode_reasoning_done: true }))
//
// 兼容策略：未启用 proposed API 或运行环境不支持时，constructor 返回 undefined，
// adapter 不 yield 思考 part，仅维护内存缓存保证多轮 reasoning_content 一致。
//
// 历史中的 LanguageModelThinkingPart：toDeepSeekMessages 优先从中提取
// reasoning_content（VS Code Stable 1.95+ / Cursor 在多轮对话中会原样保留它），
// 缓存退化为兜底来源。
//
// DeepSeek thinking 模式契约见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

/**
 * 兼容 vscode.LanguageModelThinkingPart 在某些宿主下不可用的情况。
 * 不可用时返回 undefined，调用侧需做空值兜底。
 */
function getThinkingPartCtor():
  | (typeof vscode.LanguageModelThinkingPart & {
      new (
        value: string | string[],
        id?: string,
        metadata?: { readonly [key: string]: unknown },
      ): vscode.LanguageModelThinkingPart
    })
  | undefined {
  const v = vscode as unknown as { LanguageModelThinkingPart?: unknown }
  return typeof v.LanguageModelThinkingPart === 'function'
    ? (v.LanguageModelThinkingPart as never)
    : undefined
}

/**
 * 从 assistant 消息内容中提取 LanguageModelThinkingPart 的文本（如果存在）。
 * 用于多轮对话时把上一轮的思考内容回传给 DeepSeek API（reasoning_content 字段）。
 */
function extractThinkingPartText(part: unknown): string | undefined {
  const ctor = getThinkingPartCtor()
  if (ctor && part instanceof ctor) {
    const v = (part as vscode.LanguageModelThinkingPart).value
    return Array.isArray(v) ? v.join('') : v
  }
  // 鸭子类型兜底（IPC 序列化后 instanceof 可能失效）
  const obj = part as { value?: unknown; id?: unknown; metadata?: unknown }
  if (
    obj &&
    typeof obj === 'object' &&
    (typeof obj.value === 'string' || Array.isArray(obj.value)) &&
    // ThinkingPart 至少要有 metadata 或 id 之一以区别于普通 TextPart
    (obj.id !== undefined || obj.metadata !== undefined) &&
    !('callId' in obj) // 排除 ToolCallPart
  ) {
    return Array.isArray(obj.value) ? obj.value.join('') : obj.value
  }
  return undefined
}

/**
 * 旧版（HTML marker）思考块兼容剥离正则。
 *
 * 历史背景：早期版本曾把 reasoning 包成 <details> + HTML 注释 sentinel 直接塞进
 * TextPart，会污染 assistant 历史 content。升级到 ThinkingPart 后，旧的会话
 * 历史里仍可能残留这种文本，多轮回传给 API 会和 reasoning_content 字段重复。
 * 这里保留剥离逻辑做向后兼容，纯新增对话不会触发。
 */
const LEGACY_REASONING_BLOCK_PATTERN =
  /\s*<!--MODUX_REASONING_START-->[\s\S]*?<!--MODUX_REASONING_END-->\s*/g

/**
 * 当 ThinkingPart 与 reasoningCache 都没法提供 reasoning_content 时的占位符。
 *
 * 触发场景（必须保证字段非空，否则 DeepSeek 服务端 400）：
 *   - 扩展重启 / 内存缓存被清空，且历史消息没有 ThinkingPart
 *   - 跨会话边界（旧版本生成的 tool_calls assistant 没有原始 reasoning）
 *   - VS Code 接收侧未保留 ThinkingPart 的少数边缘情况
 *
 * 用人类可读的明确文本，让模型一眼看出是丢失的占位（而非真正的思考），
 * 同时满足服务端"非空字符串"校验。
 */
const MISSING_REASONING_PLACEHOLDER =
  '(historical reasoning_content unavailable — a previous turn produced this tool call but its reasoning was not preserved across the session boundary; treat the assistant message and its tool result as ground truth and continue)'

/** DeepSeek 适配器配置（来自 config.llms 中 type=deepseek 的条目） */
interface DeepSeekConfig {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl: string
  /** 是否验证 TLS 证书，默认 true；企业代理/自签证书环境可设为 false */
  readonly rejectUnauthorized: boolean
  /**
   * thinking 模式控制
   *
   * true  → 始终开启（所有任务都使用 CoT 推理）
   *          reasoning_content 按输出价格计费（v4-pro: 6元/M promo → 24元/M 正式）
   * false → 始终关闭（最省 token，Agent 工具调用场景推荐）
   */
  readonly thinkingMode: boolean
  /**
   * 最大输出 token 数（对应 max_tokens 参数）。
   * 不设置时使用 DeepSeek 默认值（上限 384K），可能导致极长响应造成高输出计费。
   * 推荐值：8192（足够绝大多数代码任务，防止意外长响应）。
   */
  readonly maxTokens?: number
  /**
   * 采样温度（0–2）。非思考模式默认为 1；coding Agent 场景推荐 0–0.3 以减少冗余输出。
   * 注意：thinking 模式开启时 DeepSeek 不允许设置 temperature，请勿同时启用。
   */
  readonly temperature?: number
  /**
   * 模型是否支持视觉（multimodal input）。
   * true  → 图像以 OpenAI 兼容的 image_url(data URL) 格式回传
   * false → 图像剥离为简短文本占位，避免触发服务端 400
   *
   * DeepSeek 主流文本模型（chat / reasoner）当前不支持视觉，默认 false；
   * 若使用 DeepSeek-VL 等视觉模型，可在 config.json 中显式置 true。
   */
  readonly supportsVision: boolean
}

// ── OpenAI 兼容消息格式 ────────────────────────────────────────────────────────

/**
 * OpenAI multimodal content part
 *
 * GPT-4V / Claude / DeepSeek-VL 等视觉模型统一使用此结构：
 *   - 文本片段：{ type: 'text', text }
 *   - 图像片段：{ type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }
 */
type DeepSeekContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * 消息内容
   * - string：纯文本
   * - DeepSeekContentPart[]：含图像的多模态内容（仅 user / tool 角色支持）
   * - null：assistant 消息允许 content=null（仅 tool_calls）
   */
  content: string | DeepSeekContentPart[] | null
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
  /** 最后一个 chunk 中返回的用量统计，含 KV 缓存命中情况 */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
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
   *
   * 容量控制：最多保留 50 条记录，超出时淘汰最早**插入**的条目（FIFO）。
   * 之所以用 FIFO 而非真正 LRU：
   *   - get/has 命中时不更新位置，实现简单
   *   - 50 条容量在常见 50 轮以内会话足够，老条目即便被命中，下一轮
   *     toDeepSeekMessages 也会用 ThinkingPart 优先回填，缓存只是兜底
   *   - 命中后未被淘汰也不会泄露（覆写时按 fingerprint key 替换）
   * 单条 reasoning_content 典型值 500-2000 字符，50 条约 100KB，安全。
   */
  private readonly reasoningCache = new Map<string, string>()
  /** reasoningCache 最大容量（FIFO 上限）*/
  private static readonly REASONING_CACHE_MAX = 50

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

    const effectiveThinking = this.cfg.thinkingMode

    const { messages, placeholderInjected } = this.toDeepSeekMessages(
      req.messages,
      effectiveThinking,
    )
    const tools = req.tools.length > 0 ? toDeepSeekTools(req.tools) : undefined

    // 注意：DeepSeek 服务端对带 tool_calls 的历史 assistant 消息强制要求
    // reasoning_content 字段非空，且这一校验**与本轮 thinking 开关无关**。
    // 因此不能用 thinking:{type:'disabled'} 绕过，必须由 toDeepSeekMessages
    // 在转换阶段保证字段恒在（缺失时用 MISSING_REASONING_PLACEHOLDER 兜底）。

    // toolMode → tool_choice 映射
    //   Required → tool_choice: 'required'（Agent 模式，强制 LLM 调用工具）
    //   Auto / undefined → 不传（DeepSeek 默认行为等价于 'auto'）
    const toolChoice =
      tools && req.toolMode === vscode.LanguageModelChatToolMode.Required
        ? ('required' as const)
        : undefined

    // 🪙 thinking 模式由 config.json 控制（默认关闭以节省输出 token）
    //
    // v4-pro 默认开启思考模式，reasoning_content 按输出价格（6元/M promo / 24元/M regular）
    // 计费。Agent 工具调用场景不需要 CoT 推理，推荐关闭以节省 50-90% 输出 token 费用。
    // 如需恢复思考模式（复杂推理任务），在 config.json 中设置 thinkingEnabled: true。
    //
    // 注意：thinking:{type:'disabled'} 只控制本轮是否**产出** reasoning_content，
    // 不影响历史消息中已存在的 reasoning_content 字段（由 toDeepSeekMessages 保证非空）。
    const thinkingType = effectiveThinking ? 'enabled' : 'disabled'
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      stream: true,
      // stream_options 必须设置，否则 DeepSeek SSE 最后一块不包含 usage 数据，
      // KV 缓存命中率日志（prompt_cache_hit_tokens）将永远不会打印。
      stream_options: { include_usage: true },
      thinking: { type: thinkingType },
      // max_tokens：防止意外长响应导致输出 token 费用失控（默认最大 384K）
      ...(this.cfg.maxTokens ? { max_tokens: this.cfg.maxTokens } : {}),
      // temperature：非思考模式下可设低值减少冗余输出；thinking 模式下不传（服务端控制）
      ...(!effectiveThinking && this.cfg.temperature !== undefined
        ? { temperature: this.cfg.temperature }
        : {}),
    })

    log(
      `[DeepSeek Adapter] 发起请求：model=${this.cfg.model}，messages=${messages.length}，thinking=${thinkingType}` +
        (placeholderInjected ? '，部分历史 reasoning_content 缺失，已注入占位符兜底' : ''),
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
      // FIFO 淘汰：超出容量时删除最早**插入**的条目（不是最不常用）
      // 命中相同 fingerprint 时是覆写，不增加 size
      if (
        !this.reasoningCache.has(fingerprint) &&
        this.reasoningCache.size >= DeepSeekAdapter.REASONING_CACHE_MAX
      ) {
        const oldestKey = this.reasoningCache.keys().next().value
        if (oldestKey !== undefined) this.reasoningCache.delete(oldestKey)
      }
      this.reasoningCache.set(fingerprint, reasoningOut.content)
      if (reasoningOut.content) {
        log(`[DeepSeek Adapter] 缓存 reasoning_content，长度=${reasoningOut.content.length}`)
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokenCount(text)
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
      // 前置检查：避免 abort 后创建 socket 再立即 destroy 的竞态
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'))
        return
      }

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
   * 解析 SSE 流：实时 yield 文本/思考片段，同时将工具调用块累积到 partialCalls
   *
   * 思考流处理（v3，对齐 Copilot 官方）：reasoning_content 增量包成
   * LanguageModelThinkingPart 直接 yield；转入正文或工具调用时 yield 一个
   * vscode_reasoning_done 标记的 thinking part 表示思考段结束（与
   * vscode-copilot-chat languageModelAccess.ts:687-699 一致）。
   *
   * 当宿主未提供 LanguageModelThinkingPart 时静默跳过 yield，仅写入
   * reasoningOut 维持缓存一致性。
   *
   * 返回类型用 unknown 通配（标准 LanguageModelResponsePart 是 union，不含
   * proposed 的 ThinkingPart；运行时 progress.report / for-await 都能接收）。
   *
   * @param reasoningOut 输出参数：累积的 reasoning_content（用于缓存原文）
   * @param textOut      输出参数：累积的文本片段（用于指纹计算）
   */
  private async *readSseStream(
    stream: http.IncomingMessage,
    signal: AbortSignal,
    destroyRequest: () => void,
    partialCalls: Map<number, PartialToolCall>,
    reasoningOut: { content: string },
    textOut: string[],
  ): AsyncIterable<vscode.LanguageModelResponsePart> {
    const decoder = new TextDecoder()
    let leftover = '' // 跨 chunk 的不完整行缓存

    const ThinkingPartCtor = getThinkingPartCtor()
    /** 是否已开启过思考段（用于在转入正文时补发 done 标记） */
    let thinkingActive = false
    /** 是否已发送过 done 标记，避免重复 */
    let thinkingDoneSent = false

    /** 把 reasoning 增量 yield 成 ThinkingPart；ctor 不可用时直接跳过 */
    const yieldThinking = (text: string): vscode.LanguageModelResponsePart | undefined => {
      if (!ThinkingPartCtor) return undefined
      // ThinkingPart 不在标准 LanguageModelResponsePart union 内，运行时合法 → cast
      return new ThinkingPartCtor(text) as unknown as vscode.LanguageModelResponsePart
    }
    const yieldThinkingDone = (): vscode.LanguageModelResponsePart | undefined => {
      if (!ThinkingPartCtor || thinkingDoneSent) return undefined
      thinkingDoneSent = true
      return new ThinkingPartCtor('', '', {
        vscode_reasoning_done: true,
      }) as unknown as vscode.LanguageModelResponsePart
    }

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

          // KV 缓存命中统计（DeepSeek 在最后一个 chunk 中返回 usage）
          if (sseChunk.usage) {
            const hit = sseChunk.usage.prompt_cache_hit_tokens ?? 0
            const miss = sseChunk.usage.prompt_cache_miss_tokens ?? 0
            const total = hit + miss
            const hitRate = total > 0 ? Math.round((hit / total) * 100) : 0
            log(
              `[DeepSeek Adapter] KV缓存：命中 ${hit} tokens，未命中 ${miss} tokens` +
                (total > 0 ? `，命中率 ${hitRate}%（输入共 ${total} tokens）` : ''),
            )
          }

          const delta = sseChunk.choices?.[0]?.delta
          if (!delta) continue

          // thinking 模式 CoT 增量：累积原文 + yield ThinkingPart
          if (delta.reasoning_content) {
            reasoningOut.content += delta.reasoning_content
            thinkingActive = true
            const p = yieldThinking(delta.reasoning_content)
            if (p) yield p
          }

          // 即将出现非思考内容（content / tool_calls）时补发 done 标记
          const hasNonReasoning = !!delta.content || !!delta.tool_calls?.length
          if (hasNonReasoning && thinkingActive && !thinkingDoneSent) {
            const p = yieldThinkingDone()
            if (p) yield p
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
      // 流结束时若思考段还没补发 done，补一次（例如只有思考没有正文也没工具调用）
      if (thinkingActive && !thinkingDoneSent) {
        const p = yieldThinkingDone()
        if (p) yield p
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
   *   - 旧版 HTML marker 思考块（早期实现遗留）从 content 中剥离，避免重复
   *
   * **所有** assistant（含纯文本）的 reasoning_content **始终注入非空值**，
   * 三层来源优先级：
   *   1. 历史消息中的 LanguageModelThinkingPart（VS Code/Cursor 在多轮中保留）
   *   2. 内存缓存（按 callId 指纹 / 文本指纹）
   *   3. MISSING_REASONING_PLACEHOLDER 占位字符串（前两者都缺失时）
   *
   * 之所以纯文本 assistant 也强制带：DeepSeek 文档说该场景"会被忽略"，但 V4
   * 实测只要上下文里有 thinking 模式产生的消息，整段会被当作思考模式上下文
   * 做完整性校验，缺字段也可能触发 400。最保守做法是统一兜底。
   *
   * 容错策略：
   *   - 内容 part 同时支持 class 实例（instanceof）和 plain object（鸭子类型）
   *     避免 VS Code IPC 序列化后 instanceof 失效导致的类型误判
   *   - 缓存判定使用 Map.has() 区分"未命中"与"命中但为空"
   *
   * @returns messages              转换后的 DeepSeek 消息列表
   * @returns placeholderInjected   是否对至少一条 tool_calls assistant 注入了占位符
   *                                （仅用于诊断日志，不影响请求行为）
   */
  private toDeepSeekMessages(
    messages: readonly vscode.LanguageModelChatMessage[],
    effectiveThinking: boolean,
  ): {
    messages: DeepSeekMessage[]
    placeholderInjected: boolean
  } {
    const result: DeepSeekMessage[] = []
    let placeholderInjected = false

    for (const msg of messages) {
      const rawContent = msg.content as unknown[]
      // VS Code 有时将 string 内容直接存为数组外层，做兼容处理
      const parts: unknown[] = Array.isArray(rawContent) ? rawContent : [rawContent]
      const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant

      if (isAssistant) {
        const textValues: string[] = []
        const toolCallInfos: Array<{ callId: string; name: string; input: unknown }> = []
        const thinkingPieces: string[] = []

        for (const p of parts) {
          const tc = extractToolCall(p)
          if (tc) {
            toolCallInfos.push(tc)
            continue
          }
          const tk = extractThinkingPartText(p)
          if (tk !== undefined) {
            thinkingPieces.push(tk)
            continue
          }
          const tv = extractText(p)
          if (tv !== undefined) textValues.push(tv)
        }

        // 把旧版 HTML marker 思考块从 content 中剥离（向后兼容老历史），
        // 避免与 reasoning_content 字段重复发往 API
        const cleanText = textValues.join('').replace(LEGACY_REASONING_BLOCK_PATTERN, '')

        // reasoning_content 三层来源（ThinkingPart > 缓存 > 占位符）
        const thinkingFromHistory = thinkingPieces.join('')
        const hasThinkingInHistory = thinkingPieces.length > 0

        const fingerprint =
          toolCallInfos.length > 0 ? toolCallInfos.map((tc) => tc.callId).join(',') : cleanText
        const cacheHit = fingerprint ? this.reasoningCache.has(fingerprint) : false
        const cachedReasoning = cacheHit ? (this.reasoningCache.get(fingerprint) ?? '') : ''

        // reasoning_content 三层来源策略：
        //   1. 历史 ThinkingPart（thinking 模式开启时 VS Code/Cursor 保留）
        //   2. 内存缓存（按 callId / 文本指纹，本进程内跨轮次）
        //   3. MISSING_REASONING_PLACEHOLDER 兜底
        //      ⚠️  仅在 effectiveThinking=true 时注入占位符：
        //      - thinking 关闭时 API 不产出 reasoning_content，无需兜底
        //        （注入反而多费 ~58 token/条）
        //      - thinking 开启时历史 tool_calls assistant 要求 reasoning_content 非空，
        //        缺失才注入占位符（见文件头注释）
        let reasoningContent: string | undefined
        if (hasThinkingInHistory && thinkingFromHistory.length > 0) {
          reasoningContent = thinkingFromHistory
        } else if (cacheHit && cachedReasoning.length > 0) {
          reasoningContent = cachedReasoning
        } else if (effectiveThinking) {
          // thinking 开启但无实际 reasoning 可用：注入占位符保证服务端校验通过
          reasoningContent = MISSING_REASONING_PLACEHOLDER
          placeholderInjected = true
        }
        // effectiveThinking=false 且无实际 reasoning：reasoning_content 保持 undefined，
        // 不向请求中写入此字段，节省约 58 tokens/条

        if (toolCallInfos.length > 0) {
          result.push({
            role: 'assistant',
            content: cleanText.length > 0 ? cleanText : null,
            ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
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
            ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
          })
        }
      } else {
        // User 角色：先展开工具结果为独立 tool 消息，再追加文本（含可选图像）
        const toolResultMsgs: DeepSeekMessage[] = []
        const userParts: DeepSeekContentPart[] = []
        let userHasImage = false

        for (const p of parts) {
          const tr = extractToolResult(p)
          if (tr) {
            toolResultMsgs.push(this._buildToolResultMessage(tr.callId, tr.content))
            continue
          }
          const img = extractImageDataPart(p)
          if (img) {
            if (this.cfg.supportsVision) {
              userParts.push({
                type: 'image_url',
                image_url: { url: bufferToDataUrl(img.data, img.mimeType) },
              })
              userHasImage = true
            } else {
              userParts.push({
                type: 'text',
                text: `[image omitted: ${img.mimeType} (${img.data.byteLength} bytes); current model does not support vision input]`,
              })
            }
            continue
          }
          const tv = extractText(p)
          if (tv !== undefined) userParts.push({ type: 'text', text: tv })
        }

        result.push(...toolResultMsgs)
        if (userParts.length > 0) {
          // 全是文本时序列化为 string，节省服务端解析；含图像时保留数组结构
          if (!userHasImage) {
            result.push({
              role: 'user',
              content: userParts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
            })
          } else {
            result.push({ role: 'user', content: userParts })
          }
        }
      }
    }

    return { messages: result, placeholderInjected }
  }

  /**
   * 构造一条 role:tool 消息（对应 LanguageModelToolResultPart）
   *
   * 工具结果由 loop.ts 包成 [TextPart, DataPart...]，其中：
   *   - TextPart 始终存在，是工具的纯文本表述
   *   - DataPart 仅当工具返回了图像（read_file 读图）时存在
   *
   * 序列化策略：
   *   - 模型支持视觉 → 保留图像，content 用数组形式
   *   - 模型不支持视觉 → 剥离图像，content 用字符串形式（追加一行说明，让 LLM 知道有图但看不到）
   *
   * 注意：OpenAI 规范中 role:tool 的 content 仅明确支持 string；多模态 tool content
   * 是较新的扩展（GPT-4o / Anthropic 已支持，DeepSeek-VL 待验证）。当前实现保守地
   * 在 supportsVision=true 时尝试发送数组，由服务端兜底。
   */
  private _buildToolResultMessage(callId: string, content: unknown[]): DeepSeekMessage {
    const textChunks: string[] = []
    const imageParts: DeepSeekContentPart[] = []
    let strippedImages = 0

    for (const inner of content) {
      const tv = extractText(inner)
      if (tv !== undefined) {
        textChunks.push(tv)
        continue
      }
      const img = extractImageDataPart(inner)
      if (img) {
        if (this.cfg.supportsVision) {
          imageParts.push({
            type: 'image_url',
            image_url: { url: bufferToDataUrl(img.data, img.mimeType) },
          })
        } else {
          strippedImages++
        }
      }
    }

    if (this.cfg.supportsVision && imageParts.length > 0) {
      const parts: DeepSeekContentPart[] = []
      const text = textChunks.join('')
      if (text.length > 0) parts.push({ type: 'text', text })
      parts.push(...imageParts)
      return { role: 'tool', tool_call_id: callId, content: parts }
    }

    let text = textChunks.join('')
    if (strippedImages > 0) {
      text +=
        (text.length > 0 ? '\n\n' : '') +
        `[${strippedImages} image attachment(s) omitted: current model does not support vision input]`
    }
    return { role: 'tool', tool_call_id: callId, content: text }
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
 * 提取图像 DataPart 信息
 *
 * 兼容 LanguageModelDataPart 实例和 IPC 反序列化后的 plain object。
 * 仅识别 mimeType 以 image/ 开头的 part，避免误吞其他 binary 数据。
 */
function extractImageDataPart(p: unknown): { data: Uint8Array; mimeType: string } | undefined {
  if (p instanceof vscode.LanguageModelDataPart) {
    if (typeof p.mimeType === 'string' && p.mimeType.startsWith('image/')) {
      return { data: p.data, mimeType: p.mimeType }
    }
    return undefined
  }
  const obj = p as Record<string, unknown>
  if (
    obj &&
    typeof obj.mimeType === 'string' &&
    obj.mimeType.startsWith('image/') &&
    obj.data instanceof Uint8Array
  ) {
    return { data: obj.data, mimeType: obj.mimeType }
  }
  return undefined
}

/**
 * 把二进制图像数据编码为 OpenAI 兼容的 data URL
 *
 * 形如 `data:image/png;base64,iVBORw0K...`
 *
 * 注意：base64 编码会让数据膨胀 ~33%。调用前请确保图像大小已被 imageReader
 * 在源头护栏过（默认 5 MB），避免一次请求体过大被服务端截断。
 */
function bufferToDataUrl(data: Uint8Array, mimeType: string): string {
  const base64 = Buffer.from(data).toString('base64')
  return `data:${mimeType};base64,${base64}`
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
    // 支持新字段 thinkingMode（boolean）和旧字段 thinkingEnabled（boolean）
    const rawMode = 'thinkingMode' in cfg ? cfg.thinkingMode : cfg.thinkingEnabled
    const thinkingMode = rawMode === true
    const maxTokens = typeof cfg.maxTokens === 'number' ? cfg.maxTokens : undefined
    const temperature = typeof cfg.temperature === 'number' ? cfg.temperature : undefined
    const supportsVision = cfg.supportsVision === true
    return new DeepSeekAdapter({
      apiKey,
      model,
      baseUrl,
      rejectUnauthorized,
      thinkingMode,
      maxTokens,
      temperature,
      supportsVision,
    })
  },
}

registerAdapterFactory(factory)
