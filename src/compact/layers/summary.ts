import * as vscode from 'vscode'
import type { CompactResult, CompactWithLlmOptions } from '../types'
import { stripImagesForCompact, stripThinkingPartsForCompact } from './stripImages'
import { truncateMessages } from './truncate'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — 单次 LLM 摘要压缩
//
// 把历史消息送给 LLM 生成七节式结构化摘要，
// 返回 [摘要 User 消息, 接续确认 Assistant 消息] 两条消息。
//
// 七节摘要格式（参考 claude-code conversation-summary.md）：
//   § 1 Primary Request and Intent
//   § 2 Work Completed
//   § 3 Errors and Fixes
//   § 4 Pending Tasks
//   § 5 Current Working State
//   § 6 Key Code and File References
//   § 7 Next Steps
//
// 与 Layer 5（layer5-retry.ts）的关系：
//   - 本层只做单次 LLM 调用，不含重试逻辑
//   - Layer 5 包裹本层，在"context too long"错误时递进截断后重试
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 摘要压缩后 Assistant 的接续确认文本。
 * 防止 LLM 在接续时重复致辞或重述历史摘要。
 */
export const COMPACT_ACK =
  'Understood. I have the context from the previous session and will continue from where we left off.'

const COMPACT_SYSTEM_PROMPT = `You are a conversation historian. Your task is to compress the following conversation history into a structured, information-dense summary that will be used to continue the work.

The summary MUST include ALL of the following sections. Omit only sections where there is genuinely no relevant content — do not write "N/A" or placeholder text.

## 1. Primary Request and Intent
The user's core request, goal, and motivation.

## 2. Work Completed
Files modified, code written, commands executed, and their outcomes. Include exact file paths.

## 3. Errors and Fixes
Problems encountered and how they were resolved. Include exact error messages.

## 4. Pending Tasks
Tasks explicitly mentioned but not yet completed, in the order they should be done.

## 5. Current Working State
The most recent state — what was being done last, where progress stands, what the last action was.

## 6. Key Code and File References
Critical code snippets, function names, variable values, and technical details required to continue without re-reading files.

## 7. Next Steps
Planned next actions, if any. Be specific (e.g., "create file X with content Y", not "continue implementing").

Guidelines:
- Use bullet points over prose
- Preserve exact file paths, function names, variable names, and error messages
- Include code snippets verbatim where they are critical to continuing the work
- Be concise but complete; omit social commentary and evaluation`

const COMPACT_TRIGGER_PROMPT =
  'Generate the structured summary following the format described in the system instructions above.'

/**
 * 单次 LLM 摘要压缩（不含重试逻辑）。
 *
 * 流程：
 *   1. 剥离思考块 ThinkingPart（主模型推理过程，压缩模型不需要）
 *   2. 剥离图像 DataPart（Layer 2，节省 token）
 *   3. 组装 [system, ...history, trigger] 消息列表
 *   4. 调用 LLM，带超时 + 外部取消信号
 *   5. 验证摘要非空后返回 [摘要User, 接续确认Assistant]
 *
 * @param historyMessages  不含固定前缀的历史消息
 * @param opts             调用参数（适配器 / 超时 / 取消信号）
 * @param stripImages      是否剥离图像（默认 true）
 */
export async function compactWithLlm(
  historyMessages: vscode.LanguageModelChatMessage[],
  opts: CompactWithLlmOptions,
  stripImages = true,
): Promise<CompactResult> {
  // 先剥离思考块：主模型的 reasoning_content 对摘要任务没有价值，
  // 保留会导致 toDeepSeekMessages 把它们序列化为 reasoning_content 字段，
  // 产生不必要的压缩模型输入 token 开销。
  const withoutThinking = stripThinkingPartsForCompact(historyMessages)
  const sanitized = stripImages ? stripImagesForCompact(withoutThinking, true) : withoutThinking

  const requestMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(COMPACT_SYSTEM_PROMPT),
    ...sanitized,
    vscode.LanguageModelChatMessage.User(COMPACT_TRIGGER_PROMPT),
  ]

  const internalAbort = new AbortController()
  const timeoutId = setTimeout(() => internalAbort.abort(), opts.timeoutMs)

  if (opts.signal?.aborted) {
    return { success: false, error: '操作已取消' }
  }
  opts.signal?.addEventListener('abort', () => internalAbort.abort(), { once: true })

  let summary = ''
  try {
    for await (const part of opts.adapter.chat({
      messages: requestMessages,
      tools: [],
      signal: internalAbort.signal,
    })) {
      if (part instanceof vscode.LanguageModelTextPart) {
        summary += part.value
      }
    }
  } catch (err) {
    clearTimeout(timeoutId)
    if (internalAbort.signal.aborted) {
      return { success: false, error: '摘要调用超时或被取消' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `LLM 摘要调用失败：${msg}` }
  } finally {
    clearTimeout(timeoutId)
  }

  const trimmed = summary.trim()
  if (!trimmed) {
    return { success: false, error: 'LLM 返回了空摘要' }
  }

  return {
    success: true,
    messages: [
      vscode.LanguageModelChatMessage.User(
        `[Conversation history summary — earlier turns were compacted due to context limits]\n\n${trimmed}`,
      ),
      vscode.LanguageModelChatMessage.Assistant(COMPACT_ACK),
    ],
  }
}

/**
 * 初始化阶段历史摘要压缩（Layer 4 的简化调用，失败时降级为截断）。
 *
 * 仅由内部的 initCompactHistory 调用，与运行时的 PTL 重试路径区分开：
 *   - 不参与多轮 PTL 重试（避免 agent 启动时阻塞太久）
 *   - 失败直接截断，不向上抛出
 */
export async function compactHistoryOnce(
  messages: vscode.LanguageModelChatMessage[],
  opts: CompactWithLlmOptions,
  maxHistoryTurns: number,
): Promise<vscode.LanguageModelChatMessage[]> {
  const result = await compactWithLlm(messages, opts)
  if (result.success) return result.messages
  // 降级：截断
  return truncateMessages(messages, { maxTurns: maxHistoryTurns, prefixCount: 0 })
}
