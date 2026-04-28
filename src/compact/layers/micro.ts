import * as vscode from 'vscode'
import { cloneMessageWithContent, sumToolResultTextLength } from '../utils'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — 微压缩（每轮必执行）
//
// 扫描历史消息中的 ToolResultPart，把"足够老 + 足够大"的工具结果替换为
// 简短占位文本，保留 callId 配对结构（API 合法性不变）。
//
// 核心思路：LLM 推理主要依赖最近几条工具结果（工作记忆），更早的工具结果
// 已被后续回复隐性使用，再次传入只是浪费 token。
//
// 与 Layer 4 LLM 摘要的差异：
//   - 微压缩：局部替换，保持消息结构；零延迟，无信息丢失风险
//   - LLM 摘要：折叠整段历史为自然语言摘要；信息密度最高，但有调用开销
//
// 何时不替换：
//   - 最近 keepRecent 条 ToolResult（默认 6）：当前推理的工作记忆
//   - 文本总长 < minChars（默认 400）：压缩收益不足覆盖占位文本本身
//   - DataPart（图像）：由 Layer 2 独立处理
//
// 首轮行为：无 ToolResult 时两遍扫描均为空操作，性能开销可忽略不计。
// ─────────────────────────────────────────────────────────────────────────────

const MICRO_COMPACT_STUB =
  '[Earlier tool result removed by microcompaction to save context tokens. ' +
  'If you need the original content, re-invoke the tool with the same arguments.]'

export interface MicroCompactOptions {
  /** 保留最近多少条 ToolResult 不压缩（默认 6） */
  readonly keepRecent: number
  /** 单条 ToolResult 文本总长低于此值时不压缩（默认 400） */
  readonly minChars: number
  /** 结构化 payload（如 XML/日志块）的更低触发阈值（默认 220） */
  readonly structuredMinChars: number
}

export interface MicroCompactResult {
  readonly messages: vscode.LanguageModelChatMessage[]
  /** 被替换的 ToolResult 数量（0 = 无变化） */
  readonly replacedCount: number
  /** 约节省的字符数 */
  readonly savedChars: number
  /** 按结构化特征触发替换的数量 */
  readonly structuredReplacedCount: number
}

const STRUCTURED_MARKERS = [
  '<environment_info>',
  '<workspace_info>',
  '<editorContext>',
  '<reminderInstructions>',
  '<context>',
  'role:',
  'mimeType:',
  '_content:',
  '[DEBUG]',
]

/**
 * test.md 显示大量工具结果是结构化日志/XML 块；这类内容可更激进微压缩。
 */
function looksLikeStructuredPayload(text: string): boolean {
  if (!text) return false

  let markerHits = 0
  const lower = text.toLowerCase()
  for (const marker of STRUCTURED_MARKERS) {
    if (lower.includes(marker.toLowerCase())) markerHits++
  }

  if (markerHits >= 2) return true

  const lines = text.split('\n')
  if (lines.length < 8) return false

  let structuredLines = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('<') || trimmed.includes(':') || trimmed.startsWith('{')) {
      structuredLines++
    }
  }
  return structuredLines / lines.length >= 0.55
}

function flattenToolResultText(part: vscode.LanguageModelToolResultPart): string {
  let text = ''
  for (const inner of part.content) {
    if (inner instanceof vscode.LanguageModelTextPart) {
      if (text.length > 0) text += '\n'
      text += inner.value
    }
  }
  return text
}

/**
 * 对消息列表执行微压缩，返回结果及统计信息。
 *
 * 算法：两遍 O(n) 扫描
 *   第一遍（从右向左）：收集最近 keepRecent 条 ToolResult 的 callId（保留集合）
 *   第二遍（正向）：    对不在保留集合中且文本够长的 ToolResult 替换为占位文本
 *
 * 不修改输入数组；未变化的消息复用原对象引用。
 *
 * @param messages  待处理的消息列表（含前缀和历史）
 * @param opts      压缩参数
 * @param enabled   是否启用（false 时返回浅拷贝，保持签名一致）
 */
export function applyMicrocompaction(
  messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
  opts: MicroCompactOptions,
  enabled = true,
): MicroCompactResult {
  if (!enabled) {
    return {
      messages: [...messages],
      replacedCount: 0,
      savedChars: 0,
      structuredReplacedCount: 0,
    }
  }

  const keepRecent = Math.max(0, opts.keepRecent)
  const minChars = Math.max(0, opts.minChars)
  const structuredMinChars = Math.max(0, opts.structuredMinChars)

  // ── 第一遍：收集最近 keepRecent 个 ToolResultPart 的 callId ───────────────
  const recentCallIds = new Set<string>()
  for (let i = messages.length - 1; i >= 0 && recentCallIds.size < keepRecent; i--) {
    const content = messages[i].content as vscode.LanguageModelInputPart[]
    for (let j = content.length - 1; j >= 0 && recentCallIds.size < keepRecent; j--) {
      const part = content[j]
      if (part instanceof vscode.LanguageModelToolResultPart) {
        recentCallIds.add(part.callId)
      }
    }
  }

  // ── 第二遍：替换不在保留集合中的旧 ToolResultPart ────────────────────────
  let replacedCount = 0
  let savedChars = 0
  let structuredReplacedCount = 0

  const resultMessages = messages.map((msg) => {
    const content = msg.content as vscode.LanguageModelInputPart[]
    let mutated = false

    const newContent = content.map((part) => {
      if (!(part instanceof vscode.LanguageModelToolResultPart)) return part
      if (recentCallIds.has(part.callId)) return part

      const textLen = sumToolResultTextLength(part)
      const flatText = flattenToolResultText(part)
      const isStructured = looksLikeStructuredPayload(flatText)
      const threshold = isStructured ? structuredMinChars : minChars
      if (textLen < threshold) return part

      mutated = true
      replacedCount++
      if (isStructured) structuredReplacedCount++
      savedChars += textLen - MICRO_COMPACT_STUB.length
      return new vscode.LanguageModelToolResultPart(part.callId, [
        new vscode.LanguageModelTextPart(MICRO_COMPACT_STUB),
      ])
    })

    return mutated ? cloneMessageWithContent(msg, newContent) : msg
  })

  return { messages: resultMessages, replacedCount, savedChars, structuredReplacedCount }
}
