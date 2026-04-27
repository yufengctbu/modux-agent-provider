import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'
import { getCompactAdapter } from '../provider/registry'
import type { LlmAdapter } from '../provider/types'
import { estimateAllMessagesTokens, applyAutoCompactIfNeeded } from './layers/autoCompact'
import { withReactiveCompact } from './layers/reactive'
import { compactHistoryOnce } from './layers/summary'
import type { CompactWithLlmOptions } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// CompactManager — 上下文压缩外观（Facade）
//
// 对 loop.ts 暴露极简接口，让外部调用只传数据，不组装配置：
//
//   const compactMgr = new CompactManager(adapter, contextBuilder)
//
//   // 每轮 LLM 调用前：自动压缩决策（Layer 3）
//   messages = await compactMgr.applyAutoCompact(messages)
//
//   // 包裹 LLM chat 调用：响应式 context 过长重试
//   for await (const part of compactMgr.wrapChat(chatFn, messages)) { ... }
//
// 内部责任：
//   - 读取 config.compact / config.agent 中所有压缩参数
//   - 获取压缩专用 Adapter（通过 registry.getCompactAdapter()）
//   - 维护跨轮次的 autoCompact 失败计数（熔断逻辑）
//   - 组装 Layer 3 / Reactive 所需的完整选项对象
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ContextBuilder 暴露给 CompactManager 的最小接口。
 *
 * ContextBuilder 通过结构类型（Duck Typing）隐式满足此接口，
 * 无需在 chat/context.ts 中显式声明 implements 即可直接传入。
 */
export interface CompactContextBuilder {
  /** 固定前缀消息数量（System Prompt + 工作区上下文等，不参与压缩） */
  readonly prefixCount: number
  /** 获取当前存储的历史消息（不含固定前缀） */
  getHistoryMessages(): vscode.LanguageModelChatMessage[]
  /** 将压缩后的历史消息写回 ContextBuilder（替换旧历史） */
  replaceHistoryMessages(msgs: vscode.LanguageModelChatMessage[]): void
}

/**
 * 上下文压缩外观类。
 *
 * 每轮 Agent 循环对应一个 CompactManager 实例，跨轮持久化失败计数。
 * 建议在 loop.ts 每次新会话时创建一次，复用整个会话生命周期。
 */
export class CompactManager {
  /** autoCompact 连续失败次数（熔断计数器） */
  private autoCompactFailureCount = 0

  /** 压缩专用 LLM Adapter（来自 config.compact.llm，或回退到主 Adapter） */
  private readonly compactAdapter: LlmAdapter

  constructor(
    private readonly mainAdapter: LlmAdapter,
    private readonly ctx: CompactContextBuilder,
  ) {
    this.compactAdapter = getCompactAdapter()
  }

  // ── 内部工具：组装 LLM 摘要选项 ──────────────────────────────────────────────

  private buildLlmOpts(): CompactWithLlmOptions {
    return {
      adapter: this.compactAdapter,
      timeoutMs: config.compact.timeoutMs,
      maxPtlRetries: config.compact.maxPtlRetries,
    }
  }

  // ── 公开接口 ─────────────────────────────────────────────────────────────────

  /**
   * 每轮 LLM 调用前执行自动压缩（Layer 3）。
   *
   * 内部流程：
   *   1. 估算当前 token 数（Layer 3 决策依据）
   *   2. 若未达阈值，直接返回原始消息（无 IO 开销）
   *   3. 若需要压缩，调用 Layer 5 PTL 重试摘要
   *   4. 压缩成功 → 写回 ContextBuilder + 重置熔断计数器
   *   5. 压缩失败（LLM 错误）→ 写回截断结果 + 递增熔断计数器
   *   6. 熔断后仅做截断，不再调用 LLM
   *
   * @param messages  当前完整消息列表（含固定前缀，已经过 Layer 1 微压缩）
   * @returns         压缩/截断后的完整消息列表，可直接用于本轮 LLM 调用
   */
  async applyAutoCompact(
    messages: vscode.LanguageModelChatMessage[],
  ): Promise<vscode.LanguageModelChatMessage[]> {
    if (!config.agent.compactHistoryEnabled || !config.compact.autoEnabled) {
      return messages
    }

    const contextWindowSize = (this.mainAdapter as { contextWindowSize?: number }).contextWindowSize
    const window = contextWindowSize ?? 32_000
    const tokenEstimate = estimateAllMessagesTokens(messages)

    log(`[Compact] token ≈ ${tokenEstimate.toLocaleString()} / ${window.toLocaleString()}`)

    const autoResult = await applyAutoCompactIfNeeded(messages, {
      tokenEstimate,
      contextWindowSize: window,
      thresholdRatio: config.compact.autoThresholdRatio,
      hardLimitRatio: config.compact.autoHardLimitRatio,
      maxFailures: config.compact.autoMaxFailures,
      failureCount: this.autoCompactFailureCount,
      compactOpts: this.buildLlmOpts(),
      prefixCount: this.ctx.prefixCount,
      maxHistoryTurns: config.agent.maxHistoryTurns,
    })

    if (autoResult.compacted) {
      log('[Compact] LLM 摘要成功，重置熔断计数')
      this.ctx.replaceHistoryMessages(autoResult.messages.slice(this.ctx.prefixCount))
      this.autoCompactFailureCount = 0
      return autoResult.messages
    }

    if (autoResult.compactFailed) {
      this.autoCompactFailureCount++
      log(`[Compact] LLM 摘要失败（已降级为截断），累计失败 ${this.autoCompactFailureCount} 次`)
      this.ctx.replaceHistoryMessages(autoResult.messages.slice(this.ctx.prefixCount))
      return autoResult.messages
    }

    return messages
  }

  /**
   * 包裹实际的 LLM chat 调用，在 context 过长时响应式压缩并重试。
   *
   * 与 Layer 3（主动）互补：Layer 3 在请求前预防，此方法在失败后兜底。
   * 返回的 AsyncIterable 可以直接用于 `for await`，对上游代码透明。
   *
   * @param chatFn   未绑定的 LLM chat 函数（不要在外面调用，传引用即可）
   * @param messages 当前完整消息列表（经过 Layer 3 处理后的版本）
   */
  wrapChat(
    chatFn: (
      msgs: readonly vscode.LanguageModelChatMessage[],
    ) => AsyncIterable<vscode.LanguageModelResponsePart>,
    messages: readonly vscode.LanguageModelChatMessage[],
  ): AsyncIterable<vscode.LanguageModelResponsePart> {
    return withReactiveCompact(chatFn, messages, {
      enabled: config.compact.reactiveEnabled,
      maxRetries: config.compact.reactiveMaxRetries,
      getHistoryMessages: () => this.ctx.getHistoryMessages(),
      replaceHistoryMessages: (msgs) => this.ctx.replaceHistoryMessages(msgs),
      compactOpts: this.buildLlmOpts(),
      prefixCount: this.ctx.prefixCount,
      maxHistoryTurns: config.agent.maxHistoryTurns,
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// initCompactHistory — 初始化阶段历史压缩（供 ContextBuilder 使用）
//
// 与运行时 CompactManager 的区别：
//   - 单次调用，失败直接截断，不参与多轮 PTL 重试
//   - 不维护状态，函数式调用
//   - 在 ContextBuilder.buildHistoryMessages() 中调用，不在循环里
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 初始化阶段：对历史消息执行一次摘要压缩（Layer 4），失败时截断。
 *
 * 内部自动读取 config.compact 和 registry.getCompactAdapter()，
 * 调用方只需传入历史消息列表和保留条数上限。
 *
 * @param messages       原始历史消息（不含固定前缀）
 * @param maxHistoryTurns 摘要失败时截断到的保留条数
 */
export async function initCompactHistory(
  messages: vscode.LanguageModelChatMessage[],
  maxHistoryTurns: number,
): Promise<vscode.LanguageModelChatMessage[]> {
  const opts: CompactWithLlmOptions = {
    adapter: getCompactAdapter(),
    timeoutMs: config.compact.timeoutMs,
    maxPtlRetries: config.compact.maxPtlRetries,
  }
  return compactHistoryOnce(messages, opts, maxHistoryTurns)
}
