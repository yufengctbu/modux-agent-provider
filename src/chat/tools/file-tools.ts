import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 工具区域：文件系统类工具
//   - read_file  读取工作区文件（带行号，cat -n 格式）
//   - list_dir   列出目录条目（自动过滤无关目录）
//   - write_file 全量写文件（仅用于新建或完整重写）
// ─────────────────────────────────────────────────────────────────────────────

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 单次读取最大行数（对应 Claude Code MAX_LINES_TO_READ = 2000） */
const MAX_LINES_TO_READ = 2000

/** 超长文件首次输出时的行数提示阈值 */
const TRUNCATION_NOTICE_THRESHOLD = MAX_LINES_TO_READ

/** 列目录最多返回条目数 */
const MAX_DIR_ENTRIES = 100

/** 列目录时自动跳过的无关目录 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.vscode', 'out'])

// ── 安全工具函数 ──────────────────────────────────────────────────────────────

/**
 * 将用户提供的相对路径安全解析为工作区内的绝对路径。
 *
 * 严格拒绝以下情况，防止路径穿越攻击：
 *   - 传入绝对路径
 *   - 包含 `..` 跳出工作区根目录
 *
 * @returns 安全的绝对路径，或错误描述字符串（以 "ERROR:" 开头）
 */
function resolveWorkspacePath(relativePath: string): string | { error: string } {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    return { error: '未找到工作区，请先打开一个文件夹。' }
  }
  const root = folders[0].uri.fsPath
  const resolved = path.resolve(root, relativePath)

  // 确保解析后的路径仍在工作区根目录内（防止 ../ 穿越）
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { error: `路径 "${relativePath}" 超出工作区范围，拒绝访问。` }
  }
  return resolved
}

// ── read_file ─────────────────────────────────────────────────────────────────

interface ReadFileInput {
  path: string
  startLine?: number
  endLine?: number
}

export const readFileTool: ModuxTool = {
  name: 'read_file',
  description:
    '读取工作区中指定路径的文件内容。返回带行号的内容（cat -n 格式），便于精确引用行号。' +
    '可通过 startLine / endLine 读取指定范围（1-based），超过 2000 行时必须分段读取。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的文件路径' },
      startLine: { type: 'number', description: '起始行（1-based，可选，默认从第 1 行开始）' },
      endLine: { type: 'number', description: '结束行（1-based，可选，默认读到文件末尾）' },
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
      return `读取文件失败："${filePath}"：${msg}`
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

    // 超长文件提示（与 Claude Code LINE_FORMAT_INSTRUCTION 对应）
    const suffix =
      end < totalLines && end >= TRUNCATION_NOTICE_THRESHOLD
        ? `\n... [文件共 ${totalLines} 行，已显示第 ${start}–${end} 行，` +
          `使用 startLine/endLine 继续读取剩余内容]`
        : ''

    return numbered + suffix
  },
}

// ── list_dir ──────────────────────────────────────────────────────────────────

interface ListDirInput {
  path: string
}

export const listDirTool: ModuxTool = {
  name: 'list_dir',
  description:
    '列出工作区中指定目录的内容（文件和子目录）。' +
    '自动跳过 .git、node_modules、dist 等无关目录。最多返回 100 条。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的目录路径，使用 "." 表示根目录' },
    },
    required: ['path'],
  },
  isReadOnly: true,

  async execute(input: unknown): Promise<string> {
    const { path: dirPath } = input as ListDirInput

    const resolved = resolveWorkspacePath(dirPath)
    if (typeof resolved === 'object') return resolved.error

    let entries: string[]
    try {
      const dirents = await fs.readdir(resolved, { withFileTypes: true })
      entries = dirents
        .filter((d) => !IGNORED_DIRS.has(d.name))
        .slice(0, MAX_DIR_ENTRIES)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `列出目录失败："${dirPath}"：${msg}`
    }

    if (entries.length === 0) return `目录 "${dirPath}" 为空。`

    const header = `"${dirPath}" 目录内容（${entries.length} 条）：\n`
    return header + entries.join('\n')
  },
}

// ── write_file ────────────────────────────────────────────────────────────────

interface WriteFileInput {
  path: string
  content: string
}

export const writeFileTool: ModuxTool = {
  name: 'write_file',
  description:
    '向工作区中的指定路径写入内容。仅用于创建新文件或对文件进行完整重写。' +
    '修改已有文件请优先使用 edit_file（str_replace 精准编辑），避免意外覆盖。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的文件路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  isReadOnly: false,

  async execute(input: unknown): Promise<string> {
    const { path: filePath, content } = input as WriteFileInput

    const resolved = resolveWorkspacePath(filePath)
    if (typeof resolved === 'object') return resolved.error

    try {
      // 确保父目录存在
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `写入文件失败："${filePath}"：${msg}`
    }

    return `OK：已写入 "${filePath}"（${content.length} 字符）。`
  },
}
