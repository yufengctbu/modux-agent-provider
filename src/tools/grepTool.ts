import * as fs from 'node:fs/promises'
import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ***
// 工具组：代码搜索
//   - search_code  基于 vscode.workspace.findFiles + 手动正则搜索
//
// 核心价值：read_file/list_dir 只能处理"已知路径"，search_code 支持从代码片段
//           出发定位相关文件，是"先搜索再精读"工作流的基础。
//
// 为什么不用 vscode.workspace.findTextInFiles：
//   该 API 在 @types/vscode ^1.100 已移除，改为 proposed API，不适合稳定扩展使用。
//   当前方案：findFiles（glob 匹配）+ fs.readFile（内容读取）+ RegExp（搜索），
//   行为与 ripgrep 完全对等，且不依赖任何 proposed API。
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** files_with_matches 模式最多返回文件数 */
const MAX_FILES_WITH_MATCHES = 50

/** content 模式的最大结果字符数 */
const CONTENT_MODE_MAX_CHARS = 8_000

/** content 模式每个匹配项展示的前后上下文行数 */
const CONTENT_CONTEXT_LINES = 2

/** 搜索时排除的目录（glob 模式，传给 findFiles 的 exclude 参数） */
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,out}/**'

/** findFiles 最大文件数（避免在超大工作区扫描过多文件） */
const MAX_FILES_TO_SCAN = 500

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * 搜索输出模式（对应 Claude Code GrepTool 的 outputMode 参数）
 *
 * files_with_matches  只返回匹配文件的路径列表（快速定位，省 token，默认）
 * content             返回匹配行及上下文（深入分析）
 * count               返回各文件的匹配数量（评估影响范围）
 */
type SearchOutputMode = 'files_with_matches' | 'content' | 'count'

interface SearchCodeInput {
  /** 搜索 pattern，支持完整 JS RegExp 语法 */
  pattern: string
  /** 文件过滤 glob，如 "**\/*.ts"、"src/**"（可选，默认搜所有文件） */
  glob?: string
  /** 输出模式（默认 files_with_matches） */
  outputMode?: SearchOutputMode
}

/** 单个文件的搜索结果 */
interface FileMatch {
  /** 文件绝对路径 */
  filePath: string
  /** 匹配行信息 */
  lines: LineMatch[]
}

/** 单行匹配结果 */
interface LineMatch {
  /** 1-based 行号 */
  lineNumber: number
  /** 该行文本内容 */
  text: string
  /** 上下文行（lineNumber ± CONTENT_CONTEXT_LINES），仅 content 模式填充 */
  context?: string[]
}

// ── search_code ───────────────────────────────────────────────────────────────

export const searchCodeTool: ModuxTool = {
  name: 'search_code',
  description:
    'Search the workspace for code matching a pattern (full JS regex syntax supported). ' +
    'Three output modes: ' +
    'files_with_matches (default) — returns only matching file paths for quick location; ' +
    'content — returns matching lines with surrounding context for detailed reading; ' +
    'count — returns per-file match counts to assess scope. ' +
    'Prefer files_with_matches first to locate, then read_file to dive into specific files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Search pattern (JS regex syntax, e.g. "export function|export const", "interface\\s+\\w+")',
      },
      glob: {
        type: 'string',
        description:
          'Optional file filter glob (e.g. "**/*.ts" to search TypeScript files only)',
      },
      outputMode: {
        type: 'string',
        description:
          'Output mode: files_with_matches (default) | content (matching lines with context) | count (per-file match counts)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  maxResultChars: CONTENT_MODE_MAX_CHARS,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { pattern, glob, outputMode = 'files_with_matches' } = input as SearchCodeInput

    // 编译正则（全局标志确保每行可以重复匹配）
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'g')
    } catch {
      return `Search failed: invalid regular expression "${pattern}".`
    }

    // ── 第 1 步：用 findFiles 获取候选文件列表 ────────────────────────────────
    const includePattern = glob ?? '**/*'
    const uris = await vscode.workspace.findFiles(
      includePattern,
      EXCLUDE_GLOB,
      MAX_FILES_TO_SCAN,
      token,
    )

    if (uris.length === 0) {
      return `No files matched the glob "${includePattern}".`
    }

    // ── 第 2 步：逐文件读取并搜索 ──────────────────────────────────────────────
    const fileMatches: FileMatch[] = []
    const needContext = outputMode === 'content'

    for (const uri of uris) {
      if (token.isCancellationRequested) break
      // 跳过二进制文件常见扩展（避免解码乱码）
      if (isBinaryExtension(uri.fsPath)) continue

      let content: string
      try {
        content = await fs.readFile(uri.fsPath, 'utf-8')
      } catch {
        continue // 无权读取或读取失败，跳过
      }

      const lines = content.split('\n')
      const matchedLines: LineMatch[] = []

      for (let i = 0; i < lines.length; i++) {
        // 每次测试前重置 lastIndex（全局 regex 有状态）
        regex.lastIndex = 0
        if (!regex.test(lines[i])) continue

        const lineMatch: LineMatch = {
          lineNumber: i + 1, // 转为 1-based
          text: lines[i],
        }

        if (needContext) {
          // 提取前后 N 行上下文
          const start = Math.max(0, i - CONTENT_CONTEXT_LINES)
          const end = Math.min(lines.length - 1, i + CONTENT_CONTEXT_LINES)
          const contextLines: string[] = []
          for (let j = start; j <= end; j++) {
            if (j !== i) contextLines.push(`${j + 1}: ${lines[j]}`)
          }
          lineMatch.context = contextLines
        }

        matchedLines.push(lineMatch)
      }

      if (matchedLines.length > 0) {
        fileMatches.push({ filePath: uri.fsPath, lines: matchedLines })
      }
    }

    if (fileMatches.length === 0) {
      return `No matches for "${pattern}"${glob ? ` (scope: ${glob})` : ''}.`
    }

    // ── 第 3 步：按输出模式格式化结果 ────────────────────────────────────────
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''

    switch (outputMode) {
      case 'files_with_matches':
        return formatFilesWithMatches(fileMatches, root)
      case 'count':
        return formatCountMode(fileMatches, root)
      case 'content':
        return formatContentMode(fileMatches, root)
      default:
        return formatFilesWithMatches(fileMatches, root)
    }
  },
}

// ── 格式化函数 ────────────────────────────────────────────────────────────────

/** 仅输出文件路径列表（files_with_matches 模式） */
function formatFilesWithMatches(fileMatches: FileMatch[], root: string): string {
  const files = fileMatches
    .slice(0, MAX_FILES_WITH_MATCHES)
    .map(({ filePath }) => toRelPath(filePath, root))
    .sort()

  const total = fileMatches.length
  const suffix =
    total > MAX_FILES_WITH_MATCHES
      ? `\n(Showing first ${MAX_FILES_WITH_MATCHES} of ${total} files. Refine the pattern to narrow down.)`
      : ''
  return `Matching files (${files.length}):\n${files.join('\n')}${suffix}`
}

/** 输出各文件匹配计数（count 模式） */
function formatCountMode(fileMatches: FileMatch[], root: string): string {
  const lines = fileMatches
    .map(({ filePath, lines: matches }) => {
      const rel = toRelPath(filePath, root)
      return `${matches.length.toString().padStart(4)}  ${rel}`
    })
    .sort((a, b) => b.localeCompare(a))

  const totalCount = fileMatches.reduce((sum, { lines }) => sum + lines.length, 0)
  return `Match counts (${fileMatches.length} files, ${totalCount} matches total):\n${lines.join('\n')}`
}

/** 输出匹配行及上下文（content 模式） */
function formatContentMode(fileMatches: FileMatch[], root: string): string {
  const parts: string[] = []
  let totalChars = 0

  for (const { filePath, lines: matches } of fileMatches) {
    if (totalChars >= CONTENT_MODE_MAX_CHARS) break

    const rel = toRelPath(filePath, root)
    const fileParts: string[] = [`── ${rel} ──`]

    for (const match of matches) {
      fileParts.push(`  L${match.lineNumber}: ${match.text.trimEnd()}`)
      if (match.context) {
        for (const ctx of match.context) fileParts.push(`    ${ctx}`)
      }
    }

    const block = fileParts.join('\n')
    totalChars += block.length
    parts.push(block)
  }

  const suffix =
    totalChars >= CONTENT_MODE_MAX_CHARS
      ? '\n... [Output truncated. Narrow the search scope or switch to files_with_matches mode.]'
      : ''

  return parts.join('\n\n') + suffix
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 将绝对路径转换为相对于工作区根目录的相对路径 */
function toRelPath(absPath: string, root: string): string {
  return root && absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath
}

/** 常见二进制文件扩展名集合（跳过这些文件以避免 UTF-8 解码乱码） */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.map',
  '.min.js',
])

function isBinaryExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return [...BINARY_EXTENSIONS].some((ext) => lower.endsWith(ext))
}
