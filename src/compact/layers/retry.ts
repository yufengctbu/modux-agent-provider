import * as vscode from 'vscode'
import type { CompactWithLlmOptions } from '../types'
import { compactWithLlm } from './summary'
import { truncateMessages } from './truncate'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5 — PTL 渐进截断重试
//
// PTL = "Progressively-Truncating + LLM"：
//   当 Layer 4 单次 LLM 摘要失败（context 过长、超时、空返回等），
//   先按比例丢弃最旧的历史消息，再重试 LLM 摘要，最多重试 maxRetries 次。
//
// 截断策略：
//   每次重试丢弃最旧 20% 的消息（按 Assistant 轮次边界对齐），
//   三次重试后历史约压缩到 51%，通常足以解决上下文溢出。
//
// 最终兜底：
//   所有 LLM 摘要重试均失败后，直接截断至 maxHistoryTurns 条。
//   保证函数永远返回合法消息列表，不抛出异常。
//
// 职责边界：
//   - 本层是纯函数，不与外部状态（config / registry）交互
//   - Layer 3 和响应式包裹器通过本层发起带重试的摘要压缩
// ─────────────────────────────────────────────────────────────────────────────

/** 每次 PTL 重试丢弃的历史比例（丢弃最旧的 20%） */
const PTL_TRUNCATE_RATIO = 0.2

export interface CompactWithRetryOptions extends CompactWithLlmOptions {
  /** 最大重试次数（0 = 只尝试一次，不重试） */
  readonly maxRetries: number
  /** 兜底截断时保留最近多少条消息 */
  readonly maxHistoryTurns: number
}

export interface CompactWithRetryResult {
  /** 压缩后的消息（成功时为 LLM 摘要；全部重试失败后为截断结果） */
  readonly messages: vscode.LanguageModelChatMessage[]
  /** 是否最终由 LLM 摘要成功（false = 兜底截断） */
  readonly usedLlmSummary: boolean
  /** 实际重试次数（0 = 首次即成功） */
  readonly retries: number
}

/**
 * 带 PTL 重试的历史摘要压缩（Layer 5）。
 *
 * @param historyMessages  不含固定前缀的原始历史消息
 * @param opts             压缩参数（含 maxRetries, maxHistoryTurns）
 */
export async function compactWithRetry(
  historyMessages: vscode.LanguageModelChatMessage[],
  opts: CompactWithRetryOptions,
): Promise<CompactWithRetryResult> {
  let current = historyMessages
  let attempt = 0

  while (true) {
    const result = await compactWithLlm(current, opts)
    if (result.success) {
      return { messages: result.messages, usedLlmSummary: true, retries: attempt }
    }

    if (attempt >= opts.maxRetries) break

    attempt++
    current = dropOldestTurns(current, PTL_TRUNCATE_RATIO)
    if (current.length === 0) break
  }

  const fallback = truncateMessages(historyMessages, {
    maxTurns: opts.maxHistoryTurns,
    prefixCount: 0,
  })
  return { messages: fallback, usedLlmSummary: false, retries: attempt }
}

/**
 * 丢弃历史消息中最旧的 `ratio` 比例，以 Assistant 轮次边界对齐。
 *
 * 对齐策略：先计算目标丢弃量，然后从左向右扫描找第一个 Assistant 消息边界，
 * 保证删除到一个完整"对话轮次"的末尾，不留下孤立的 User 消息。
 */
function dropOldestTurns(
  messages: vscode.LanguageModelChatMessage[],
  ratio: number,
): vscode.LanguageModelChatMessage[] {
  if (messages.length === 0 || ratio <= 0) return messages

  const targetDrop = Math.ceil(messages.length * ratio)
  let dropIndex = targetDrop

  for (let i = targetDrop; i < messages.length; i++) {
    if (messages[i].role === vscode.LanguageModelChatMessageRole.Assistant) {
      dropIndex = i + 1
      break
    }
  }

  // 至少保留 1 条消息
  dropIndex = Math.min(dropIndex, messages.length - 1)
  return messages.slice(dropIndex)
}
