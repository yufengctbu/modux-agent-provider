import * as vscode from 'vscode'
import { getTokenManager } from '../../token'
import type { AutoCompactOptions, AutoCompactResult } from '../types'
import { compactWithRetry } from './retry'
import { truncateMessages } from './truncate'

const tokenManager = getTokenManager()

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — Token 感知自动压缩（决策层）
//
// 在每轮 LLM 调用前执行 token 预算检查，决定是否触发 Layer 4/5 压缩链。
//
// 决策树（按优先级）：
//   tokens < threshold                 → 无需压缩，直接返回原始消息
//   tokens >= hard_limit               → 先强制截断再走 LLM（双保险）
//   failureCount >= maxFailures        → 熔断：跳过 LLM，直接截断
//   默认                               → 调用 Layer 5 PTL 重试压缩
//
// threshold vs hard_limit：
//   threshold（默认 75%）：软触发——上下文有余地，LLM 有足够空间生成摘要
//   hard_limit（默认 92%）：硬触发——上下文几乎满了，先截断再摘要（防 OOM）
//
// 熔断机制：
//   由 CompactManager 维护 failureCount 跨轮次传入，连续失败 maxFailures 次后
//   自动降级为截断，避免每轮重复触发高代价但注定失败的 LLM 摘要调用。
//
// 职责边界：
//   - 本层只做决策 + 调度，不直接发起 LLM 调用
//   - 所有 LLM 调用都经由 Layer 4/5 执行
// ─────────────────────────────────────────────────────────────────────────────

/** 默认上下文窗口大小，当 Adapter 未声明 contextWindowSize 时使用 */
const DEFAULT_CONTEXT_WINDOW = 32_000

/**
 * 估算消息列表的总 token 数（含所有消息的 role + content overhead）
 */
export function estimateAllMessagesTokens(
  messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
  llmType?: string,
): number {
  return tokenManager.countMessages(llmType, messages)
}

/**
 * Token 感知自动压缩（Layer 3 决策入口）。
 *
 * @param messages  当前完整消息列表（含固定前缀）
 * @param opts      本轮压缩参数（由 CompactManager 从 config 组装后传入）
 */
export async function applyAutoCompactIfNeeded(
  messages: vscode.LanguageModelChatMessage[],
  opts: AutoCompactOptions,
): Promise<AutoCompactResult> {
  const { tokenEstimate, contextWindowSize, thresholdRatio, hardLimitRatio, prefixCount } = opts
  const window = contextWindowSize > 0 ? contextWindowSize : DEFAULT_CONTEXT_WINDOW
  const softThreshold = window * thresholdRatio
  const hardLimit = window * hardLimitRatio

  // ── 未达阈值：无需任何压缩 ─────────────────────────────────────────────────
  if (tokenEstimate < softThreshold) {
    return { messages, compacted: false, compactFailed: false }
  }

  const prefix = messages.slice(0, prefixCount)
  let history = messages.slice(prefixCount)

  // ── 超过硬上限：先截断，再走 LLM（双保险）────────────────────────────────
  if (tokenEstimate >= hardLimit) {
    history = truncateMessages(history, {
      maxTurns: Math.max(1, opts.maxHistoryTurns),
      prefixCount: 0,
    })
  }

  // ── 熔断：连续失败已达上限，只做截断 ──────────────────────────────────────
  if (opts.failureCount >= opts.maxFailures) {
    const truncated = truncateMessages(history, { maxTurns: opts.maxHistoryTurns, prefixCount: 0 })
    return { messages: [...prefix, ...truncated], compacted: false, compactFailed: false }
  }

  // ── 调用 Layer 5 PTL 重试压缩 ──────────────────────────────────────────────
  const retryResult = await compactWithRetry(history, {
    ...opts.compactOpts,
    maxRetries: opts.compactOpts.maxPtlRetries,
    maxHistoryTurns: opts.maxHistoryTurns,
  })

  return {
    messages: [...prefix, ...retryResult.messages],
    compacted: retryResult.usedLlmSummary,
    compactFailed: !retryResult.usedLlmSummary,
  }
}
