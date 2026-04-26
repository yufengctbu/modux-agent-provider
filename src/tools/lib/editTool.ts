import * as fs from 'node:fs/promises'
import type { ModuxTool, ToolExecuteContext } from '../types'
import { resolveWorkspacePath } from '../utils'

// ***
// 工具组：精准文件编辑
//   - edit_file  str_replace 模式：old_string → new_string
//
// 设计原则：
//   1. old_string 在文件中必须只匹配一处，否则返回错误（防止错位替换）
//   2. 编辑前应先用 read_file 读取文件（由 System Prompt 约束，非此工具负责）
//   3. 成功后返回变更前后的上下文行，供 LLM 验证结果
// ***

/** 替换成功后，在变更位置前后各展示的行数 */
const CONTEXT_LINES_ON_SUCCESS = 5

// ── edit_file ─────────────────────────────────────────────────────────────────

interface EditFileInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const name = 'edit_file'

export const editFileTool: ModuxTool = {
  name,
  description:
    'Perform a precise str_replace edit on a file in the workspace (old_string → new_string). ' +
    'old_string must match exactly once in the file; if it matches multiple times, add more surrounding context to make it unique. ' +
    'Set replace_all=true to replace every occurrence (useful for renaming). ' +
    'You must read the file with read_file before editing to confirm the exact text and indentation of old_string.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file, relative to the workspace root',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to replace, including indentation and newlines',
      },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences instead of only the first (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  maxResultChars: 2000,

  async execute(input: unknown, ctx: ToolExecuteContext): Promise<string> {
    const { file_path, old_string, new_string, replace_all = false } = input as EditFileInput

    const resolved = resolveWorkspacePath(file_path)
    if (typeof resolved === 'object') return resolved.error

    let original: string
    try {
      original = await fs.readFile(resolved, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Failed to read file "${file_path}": ${msg}`
    }

    // ── 唯一性检查 ────────────────────────────────────────────────────────────
    const occurrences = countOccurrences(original, old_string)

    if (occurrences === 0) {
      return (
        `Edit failed: old_string not found in "${file_path}".\n` +
        `Re-read the file with read_file and verify the exact text (including indentation and whitespace).`
      )
    }

    if (!replace_all && occurrences > 1) {
      return (
        `Edit failed: old_string matches ${occurrences} locations in "${file_path}" (must be unique).\n` +
        `Add more surrounding context lines to make it unique, or use replace_all=true to replace all occurrences.`
      )
    }

    // ── 执行替换 ──────────────────────────────────────────────────────────────
    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string)

    try {
      await fs.writeFile(resolved, updated, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Failed to write file "${file_path}": ${msg}`
    }

    ctx.fileState.invalidate(resolved)

    // ── 返回变更周边上下文，供 LLM 验证 ──────────────────────────────────────
    const replacedCount = replace_all ? occurrences : 1
    const context = extractContextAroundChange(updated, new_string, CONTEXT_LINES_ON_SUCCESS)

    return `OK: Replaced ${replacedCount} occurrence(s) in "${file_path}".\n\nContext after edit:\n${context}`
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 统计 needle 在 haystack 中非重叠出现的次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * 提取 content 中 needle 首次出现位置的前后上下文行。
 * 用于让 LLM 验证替换结果是否符合预期。
 */
function extractContextAroundChange(content: string, needle: string, contextLines: number): string {
  const pos = content.indexOf(needle)
  if (pos === -1) return '(unable to extract context)'

  const lines = content.split('\n')
  let charCount = 0
  let targetLine = 0
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1 // +1 for \n
    if (charCount > pos) {
      targetLine = i
      break
    }
  }

  const from = Math.max(0, targetLine - contextLines)
  const to = Math.min(lines.length - 1, targetLine + contextLines)
  const lineWidth = String(to + 1).length

  return lines
    .slice(from, to + 1)
    .map((line, i) => `${String(from + i + 1).padStart(lineWidth)}  ${line}`)
    .join('\n')
}
