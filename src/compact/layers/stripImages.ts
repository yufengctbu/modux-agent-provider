import * as vscode from 'vscode'
import { cloneMessageWithContent } from '../utils'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — 图像剥离
//
// 在 LLM 摘要压缩（Layer 4）前移除消息中的图像 DataPart。
// 摘要是纯文本归纳任务：图像增加 token 成本，且文字-only 模型会直接报错。
//
// 职责边界：
//   - 只剥离 DataPart，不触碰文本内容
//   - 未含图像的消息直接复用原引用（零分配）
//   - 由 Layer 4 在调用 LLM 前自动触发，不对外独立暴露
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_OMIT_PLACEHOLDER = '[image omitted for summary]'

/**
 * 剥离消息中的所有图像 DataPart，替换为文本占位。
 *
 * 处理两种图像位置：顶层 DataPart、ToolResultPart 内嵌的 DataPart。
 * 未含图像的消息复用原对象引用，避免不必要的内存分配。
 *
 * @param messages  待处理的消息列表
 * @param enabled   可选开关，false 时直接返回原列表
 */
export function stripImagesForCompact(
  messages: vscode.LanguageModelChatMessage[],
  enabled = true,
): vscode.LanguageModelChatMessage[] {
  if (!enabled) return messages

  return messages.map((msg) => {
    const content = msg.content as vscode.LanguageModelInputPart[]
    let mutated = false
    const newContent: vscode.LanguageModelInputPart[] = []

    for (const part of content) {
      // ── 顶层 DataPart → 文本占位 ───────────────────────────────────────────
      if (part instanceof vscode.LanguageModelDataPart) {
        mutated = true
        newContent.push(new vscode.LanguageModelTextPart(IMAGE_OMIT_PLACEHOLDER))
        continue
      }
      // ── ToolResultPart 内嵌 DataPart → 重建，保留文本部分 ─────────────────
      if (part instanceof vscode.LanguageModelToolResultPart) {
        let innerMutated = false
        const filteredInner: unknown[] = []
        for (const inner of part.content) {
          if (inner instanceof vscode.LanguageModelDataPart) {
            innerMutated = true
            filteredInner.push(new vscode.LanguageModelTextPart(IMAGE_OMIT_PLACEHOLDER))
          } else {
            filteredInner.push(inner)
          }
        }
        if (innerMutated) {
          mutated = true
          newContent.push(new vscode.LanguageModelToolResultPart(part.callId, filteredInner))
        } else {
          newContent.push(part)
        }
        continue
      }
      newContent.push(part)
    }

    return mutated ? cloneMessageWithContent(msg, newContent) : msg
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 思考块（ThinkingPart）剥离
//
// 在 LLM 摘要压缩（Layer 4）前移除 assistant 消息中的 ThinkingPart 内容。
//
// 动机：
//   修复"reasoning_content 未纳入 token 估算"问题后，appendAssistantTurn 会把
//   每轮的推理文本以鸭子类型 ThinkingPart（{ value, id, metadata }）存入历史。
//   toDeepSeekMessages 会把这些 part 的 value 提取为 reasoning_content 字段并
//   回传给压缩模型。但摘要任务只需要对话内容（文本/工具调用/结果），不需要主
//   模型的内部推理过程，发过去只是白白消耗压缩模型的输入 token 预算。
//
// 检测逻辑（兼容 class 实例和鸭子类型）：
//   有 value:string|string[]、有 id 或 metadata、且无 callId
//   与 LanguageModelTextPart（只有 value，无 id/metadata）和
//   LanguageModelToolCallPart（有 callId）不冲突
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断一个 content part 是否为思考块（ThinkingPart class 实例或鸭子类型）。
 * @internal
 */
function isThinkingPartLike(part: unknown): boolean {
  if (part === null || typeof part !== 'object') return false
  const obj = part as Record<string, unknown>
  return (
    (typeof obj['value'] === 'string' || Array.isArray(obj['value'])) &&
    (obj['id'] !== undefined || obj['metadata'] !== undefined) &&
    !('callId' in obj)
  )
}

/**
 * 剥离 assistant 消息中的思考块（ThinkingPart），用于发给压缩专用 LLM 前的预处理。
 *
 * 压缩模型（如 deepseek-v4-flash）不需要主模型的内部推理过程来生成摘要；
 * 保留会导致 reasoning_content 字段被回传，产生不必要的输入 token 消耗。
 * 剥离后仅保留文本、工具调用和工具结果部分，信息完整性不受影响。
 *
 * 未含 ThinkingPart 的消息直接复用原对象引用（零分配）。
 */
export function stripThinkingPartsForCompact(
  messages: vscode.LanguageModelChatMessage[],
): vscode.LanguageModelChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== vscode.LanguageModelChatMessageRole.Assistant) return msg

    const content = msg.content as vscode.LanguageModelInputPart[]
    let mutated = false
    const newContent: vscode.LanguageModelInputPart[] = []

    for (const part of content) {
      if (isThinkingPartLike(part)) {
        mutated = true
        continue // 丢弃思考块
      }
      newContent.push(part)
    }

    return mutated ? cloneMessageWithContent(msg, newContent) : msg
  })
}
