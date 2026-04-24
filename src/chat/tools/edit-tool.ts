import * as fs from 'fs/promises'
import * as path from 'path'
import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 工具区域：精准文件编辑
//   - edit_file  str_replace 模式：old_string → new_string
//
// 设计原则（来自 Claude Code FileEditTool）：
//   1. old_string 必须在文件中唯一匹配，否则返回错误（防止误改错误位置）
//   2. 修改前应已用 read_file 读取文件（System Prompt 层约束，工具层不强制）
//   3. 成功返回修改后的上下文行，让 LLM 确认结果正确
// ─────────────────────────────────────────────────────────────────────────────

/** 修改成功后展示的上下文行数（前后各 N 行） */
const CONTEXT_LINES_ON_SUCCESS = 5

/**
 * 将用户提供的相对路径安全解析为工作区内的绝对路径。
 * （与 file-tools.ts 保持相同的安全边界，各文件独立实现以避免循环依赖）
 */
function resolveWorkspacePath(relativePath: string): string | { error: string } {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    return { error: '未找到工作区，请先打开一个文件夹。' }
  }
  const root = folders[0].uri.fsPath
  const resolved = path.resolve(root, relativePath)

  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { error: `路径 "${relativePath}" 超出工作区范围，拒绝访问。` }
  }
  return resolved
}

// ── edit_file ─────────────────────────────────────────────────────────────────

interface EditFileInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const editFileTool: ModuxTool = {
  name: 'edit_file',
  description:
    '对工作区中的文件进行精准的 str_replace 编辑（old_string → new_string）。' +
    'old_string 必须在文件中唯一匹配；若匹配不唯一，请增加更多上下文行使其唯一。' +
    'replace_all=true 时替换所有匹配项（适用于批量重命名）。' +
    '修改前必须先用 read_file 读取文件内容，确认 old_string 的精确文本和缩进。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '相对于工作区根目录的文件路径' },
      old_string: { type: 'string', description: '要替换的精确文本（含缩进和换行）' },
      new_string: { type: 'string', description: '替换后的文本' },
      replace_all: {
        type: 'boolean',
        description: '是否替换所有匹配项（默认 false，仅替换第一个）',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  maxResultChars: 2000,

  async execute(input: unknown): Promise<string> {
    const { file_path, old_string, new_string, replace_all = false } = input as EditFileInput

    const resolved = resolveWorkspacePath(file_path)
    if (typeof resolved === 'object') return resolved.error

    let original: string
    try {
      original = await fs.readFile(resolved, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `读取文件失败："${file_path}"：${msg}`
    }

    // ── 唯一性校验 ────────────────────────────────────────────────────────────
    const occurrences = countOccurrences(original, old_string)

    if (occurrences === 0) {
      return (
        `编辑失败：在 "${file_path}" 中未找到 old_string。\n` +
        `请用 read_file 重新读取文件，确认 old_string 的精确文本（含缩进和空白字符）。`
      )
    }

    if (!replace_all && occurrences > 1) {
      return (
        `编辑失败：old_string 在 "${file_path}" 中匹配了 ${occurrences} 处（要求唯一）。\n` +
        `请增加更多上下文行使其唯一，或使用 replace_all=true 替换所有匹配项。`
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
      return `写入文件失败："${file_path}"：${msg}`
    }

    // ── 返回修改后的上下文行（确认结果） ────────────────────────────────────
    const replacedCount = replace_all ? occurrences : 1
    const context = extractContextAroundChange(updated, new_string, CONTEXT_LINES_ON_SUCCESS)

    return `OK：已在 "${file_path}" 中替换 ${replacedCount} 处。\n\n` + `修改后上下文：\n${context}`
  },
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 统计 needle 在 haystack 中不重叠出现的次数 */
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
 * 提取 new_string 首次出现位置前后 contextLines 行的文本。
 * 用于让 LLM 确认替换结果符合预期。
 */
function extractContextAroundChange(content: string, needle: string, contextLines: number): string {
  const pos = content.indexOf(needle)
  if (pos === -1) return '（无法提取上下文）'

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
