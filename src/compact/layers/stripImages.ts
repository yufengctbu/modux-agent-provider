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
