import * as vscode from 'vscode'
import type { ReactiveCompactOptions } from '../types'
import { isContextTooLongError } from '../utils'
import { compactWithRetry } from './retry'

// ─────────────────────────────────────────────────────────────────────────────
// Reactive 压缩包裹器
//
// 包裹实际的 LLM chat 调用，在 runtime 捕获"context 过长"错误，
// 立即执行 Layer 5 PTL 重试压缩后，再重新发起 chat 调用。
//
// 与 Layer 3 的区别：
//   Layer 3（auto）：主动在请求前检测 token 预算，预防性压缩
//   Reactive：被动响应——Layer 3 误判/未触发时的最后一道防线
//
// 设计要点：
//   - 以 async generator 实现，对上游 `for await` 透明
//   - 捕获 context_length_exceeded / context too long 等错误信号
//   - 成功压缩后原地更新 ContextBuilder（replaceHistoryMessages）
//   - 超过 maxRetries 后继续抛出，让外层决定是否终止本轮推理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 包裹 LLM chat 调用，在 context 过长时自动压缩并重试（响应式）。
 *
 * @param chatFn   原始 LLM chat 函数引用
 * @param messages 当前完整消息列表（含前缀）
 * @param opts     响应式压缩参数（由 CompactManager 从 config 组装）
 */
export async function* withReactiveCompact(
  chatFn: (
    msgs: readonly vscode.LanguageModelChatMessage[],
  ) => AsyncIterable<vscode.LanguageModelResponsePart>,
  messages: readonly vscode.LanguageModelChatMessage[],
  opts: ReactiveCompactOptions,
): AsyncIterable<vscode.LanguageModelResponsePart> {
  if (!opts.enabled) {
    yield* chatFn(messages)
    return
  }

  const { prefixCount, maxHistoryTurns, maxRetries, getHistoryMessages, replaceHistoryMessages } =
    opts

  let currentMessages = messages
  let retries = 0

  while (true) {
    try {
      yield* chatFn(currentMessages)
      return
    } catch (err) {
      if (!isContextTooLongError(err) || retries >= maxRetries) throw err

      retries++
      const history = getHistoryMessages()
      const retryResult = await compactWithRetry(history, {
        ...opts.compactOpts,
        maxRetries: opts.compactOpts.maxPtlRetries,
        maxHistoryTurns,
      })

      replaceHistoryMessages(retryResult.messages)
      const newHistory = retryResult.messages
      currentMessages = buildFallbackMessages(currentMessages, prefixCount, newHistory)
    }
  }
}

/**
 * 将压缩后的新历史替换到当前消息列表。
 *
 * 固定前缀来自 currentMessages 头部，尾部的"本轮追加消息"（pending turn）
 * 在此不保留——响应式场景下 context 过长意味着本轮必须整体重新发起。
 *
 * @internal
 */
export function buildFallbackMessages(
  currentMessages: readonly vscode.LanguageModelChatMessage[],
  prefixCount: number,
  newHistory: vscode.LanguageModelChatMessage[],
): vscode.LanguageModelChatMessage[] {
  const prefix = currentMessages.slice(0, prefixCount)
  return [...prefix, ...newHistory]
}
