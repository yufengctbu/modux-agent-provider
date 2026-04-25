import * as fs from 'node:fs/promises'
import type { ModuxTool } from '../types'
import { resolveWorkspacePath } from '../utils'

// ***
// 工具：读取工作区文件（带行号，cat -n 格式）
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 单次读取最大行数（2000 行） */
const MAX_LINES_TO_READ = 2000

/** 超长文件输出时的截断提示阈值 */
const TRUNCATION_NOTICE_THRESHOLD = MAX_LINES_TO_READ

// ── read_file ─────────────────────────────────────────────────────────────────

interface ReadFileInput {
  path: string
  startLine?: number
  endLine?: number
}

export const name = 'read_file'

export const readFileTool: ModuxTool = {
  name,
  description:
    'Read a file from the workspace. Returns content with line numbers (cat -n format) for precise line references. ' +
    'Use startLine/endLine to read a specific range (1-based). Files longer than 2000 lines must be read in sections.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root' },
      startLine: { type: 'number', description: 'First line to read, 1-based (default: 1)' },
      endLine: { type: 'number', description: 'Last line to read, 1-based (default: end of file)' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  maxResultChars: 20000,

  async execute(input: unknown): Promise<string> {
    const { path: filePath, startLine, endLine } = input as ReadFileInput

    const resolved = resolveWorkspacePath(filePath)
    if (typeof resolved === 'object') return resolved.error

    let content: string
    try {
      content = await fs.readFile(resolved, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Failed to read file "${filePath}": ${msg}`
    }

    const allLines = content.split('\n')
    const totalLines = allLines.length

    // 计算实际读取范围（1-based → 0-based index）
    const start = Math.max(1, startLine ?? 1)
    const rawEnd = endLine ?? totalLines
    const end = Math.min(rawEnd, start + MAX_LINES_TO_READ - 1, totalLines)

    const slicedLines = allLines.slice(start - 1, end)
    const lineWidth = String(totalLines).length // 行号对齐宽度

    // cat -n 格式：右对齐行号 + 两个空格 + 内容
    const numbered = slicedLines
      .map((line, i) => `${String(start + i).padStart(lineWidth)}  ${line}`)
      .join('\n')

    // 还有更多行未显示时，追加截断提示
    const suffix =
      end < totalLines && end >= TRUNCATION_NOTICE_THRESHOLD
        ? `\n... [File has ${totalLines} lines total. Showing lines ${start}–${end}. ` +
          `Use startLine/endLine to read the rest.]`
        : ''

    return numbered + suffix
  },
}
