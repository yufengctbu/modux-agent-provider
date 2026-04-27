import * as vscode from 'vscode'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 6 — 硬截断（最终兜底）
//
// 所有上层压缩策略（LLM 摘要、PTL 重试）都失败后的最后一道防线。
// 简单截取最近 N 条历史消息，保证消息列表不超出上下文窗口。
//
// 职责边界：
//   - 只负责截断，不调用 LLM，不做任何内容分析
//   - 保护固定前缀（通过 prefixCount 指定），不参与截断
//   - 返回新数组，不修改原始输入
// ─────────────────────────────────────────────────────────────────────────────

export interface TruncateOptions {
  /** 保留最近多少条历史消息（不含固定前缀） */
  readonly maxTurns: number
  /** 固定前缀消息数量（直接保留，不参与截断） */
  readonly prefixCount: number
}

/**
 * 对消息列表执行硬截断。
 *
 * 固定前缀（索引 0 ~ prefixCount-1）原样保留；
 * 历史区间（索引 prefixCount ~ end）截取最后 maxTurns 条。
 *
 * @example
 * // prefix=[S,A,W,WA], history=[m1...m20], maxTurns=10
 * // → [S,A,W,WA, m11...m20]
 */
export function truncateMessages(
  messages: vscode.LanguageModelChatMessage[],
  opts: TruncateOptions,
): vscode.LanguageModelChatMessage[] {
  const { maxTurns, prefixCount } = opts
  const safePrefix = Math.min(prefixCount, messages.length)
  const prefix = messages.slice(0, safePrefix)
  const history = messages.slice(safePrefix)
  const truncatedHistory = maxTurns > 0 ? history.slice(-maxTurns) : []
  return [...prefix, ...truncatedHistory]
}
