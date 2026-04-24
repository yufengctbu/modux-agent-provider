import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 工具区域：代码搜索
//   - search_code  基于 vscode.workspace.findTextInFiles()，无需启动 shell 进程
//
// 设计来源：Claude Code GrepTool（ripgrep）+ GlobTool
// 核心价值：read_file/list_dir 只能处理"已知路径"，search_code 支持从代码片段
//           出发定位相关文件，是"先搜索再精读"工作流的基础。
// ─────────────────────────────────────────────────────────────────────────────

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** files_with_matches 模式最多返回文件数 */
const MAX_FILES_WITH_MATCHES = 50

/** content 模式的最大结果字符数 */
const CONTENT_MODE_MAX_CHARS = 8000

/** content 模式每个匹配项展示的前后上下文行数 */
const CONTENT_CONTEXT_LINES = 2

/** 搜索时排除的目录（glob 模式） */
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,out}/**'

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
  /** 文件过滤 glob，如 "**\/*.ts"、"src/**"（可选） */
  glob?: string
  /** 输出模式（默认 files_with_matches） */
  outputMode?: SearchOutputMode
}

// ── search_code ───────────────────────────────────────────────────────────────

export const searchCodeTool: ModuxTool = {
  name: 'search_code',
  description:
    '在工作区中搜索匹配指定模式的代码。支持正则表达式。' +
    '三种输出模式：' +
    'files_with_matches（默认）—— 只返回匹配文件路径，快速定位；' +
    'content —— 返回匹配行及上下文，用于深入分析；' +
    'count —— 返回各文件的匹配数量，评估影响范围。' +
    '建议先用 files_with_matches 定位，再用 read_file 精读目标文件。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索 pattern（支持正则表达式，如 "export function|export const"）',
      },
      glob: {
        type: 'string',
        description: '文件过滤 glob（可选，如 "**/*.ts" 只搜 TypeScript 文件）',
      },
      outputMode: {
        type: 'string',
        description:
          '输出模式：files_with_matches（默认）| content（含上下文行）| count（各文件计数）',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  maxResultChars: CONTENT_MODE_MAX_CHARS,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { pattern, glob, outputMode = 'files_with_matches' } = input as SearchCodeInput

    // 将用户 pattern 转为 VS Code findTextInFiles 所需的 RegExp
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      return `搜索失败：无效的正则表达式 "${pattern}"。`
    }

    // 收集所有匹配结果
    const matchesByFile = new Map<string, vscode.TextSearchMatch[]>()

    try {
      await vscode.workspace.findTextInFiles(
        { pattern, isRegExp: true },
        {
          include: glob,
          exclude: EXCLUDE_GLOB,
          maxResults: outputMode === 'files_with_matches' ? MAX_FILES_WITH_MATCHES * 3 : 500,
        },
        (result) => {
          if (token.isCancellationRequested) return
          if (!('ranges' in result)) return // 跳过 URI-only 结果
          const uri = result.uri.fsPath
          const existing = matchesByFile.get(uri) ?? []
          existing.push(result as vscode.TextSearchMatch)
          matchesByFile.set(uri, existing)
        },
        token,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `搜索失败：${msg}`
    }

    if (matchesByFile.size === 0) {
      return `未找到匹配 "${pattern}" 的内容${glob ? `（限定范围：${glob}）` : ''}。`
    }

    // ── 按输出模式格式化结果 ──────────────────────────────────────────────────
    switch (outputMode) {
      case 'files_with_matches':
        return formatFilesWithMatches(matchesByFile)

      case 'count':
        return formatCountMode(matchesByFile)

      case 'content':
        return formatContentMode(matchesByFile, regex)

      default:
        return formatFilesWithMatches(matchesByFile)
    }
  },
}

// ── 格式化函数 ────────────────────────────────────────────────────────────────

/** 仅输出文件路径列表（files_with_matches 模式） */
function formatFilesWithMatches(matchesByFile: Map<string, vscode.TextSearchMatch[]>): string {
  const folders = vscode.workspace.workspaceFolders
  const root = folders?.[0]?.uri.fsPath ?? ''

  const files = [...matchesByFile.keys()]
    .slice(0, MAX_FILES_WITH_MATCHES)
    .map((abs) => (root && abs.startsWith(root) ? abs.slice(root.length + 1) : abs))
    .sort()

  const total = matchesByFile.size
  const suffix =
    total > MAX_FILES_WITH_MATCHES
      ? `\n（仅显示前 ${MAX_FILES_WITH_MATCHES} 个文件，共 ${total} 个）`
      : ''
  return `匹配文件（${files.length} 个）：\n${files.join('\n')}${suffix}`
}

/** 输出各文件匹配计数（count 模式） */
function formatCountMode(matchesByFile: Map<string, vscode.TextSearchMatch[]>): string {
  const folders = vscode.workspace.workspaceFolders
  const root = folders?.[0]?.uri.fsPath ?? ''

  const lines = [...matchesByFile.entries()]
    .map(([abs, matches]) => {
      const rel = root && abs.startsWith(root) ? abs.slice(root.length + 1) : abs
      return `${matches.length.toString().padStart(4)}  ${rel}`
    })
    .sort((a, b) => b.localeCompare(a)) // 按文件名排序

  const totalCount = [...matchesByFile.values()].reduce((sum, m) => sum + m.length, 0)
  return `匹配数量（${matchesByFile.size} 个文件，共 ${totalCount} 处）：\n${lines.join('\n')}`
}

/** 输出匹配行及上下文（content 模式） */
function formatContentMode(
  matchesByFile: Map<string, vscode.TextSearchMatch[]>,
  _regex: RegExp,
): string {
  const folders = vscode.workspace.workspaceFolders
  const root = folders?.[0]?.uri.fsPath ?? ''

  const parts: string[] = []
  let totalChars = 0

  for (const [abs, matches] of matchesByFile) {
    if (totalChars >= CONTENT_MODE_MAX_CHARS) break

    const rel = root && abs.startsWith(root) ? abs.slice(root.length + 1) : abs
    const fileParts: string[] = [`── ${rel} ──`]

    for (const match of matches) {
      if (!('ranges' in match)) continue

      // VS Code TextSearchMatch 的 preview.text 包含匹配行文本
      const lineNum = Array.isArray(match.ranges)
        ? (match.ranges[0] as vscode.Range).start.line + 1
        : (match.ranges as vscode.Range).start.line + 1

      const previewText = match.preview.text.trimEnd()
      fileParts.push(`  L${lineNum}: ${previewText}`)
    }

    const block = fileParts.join('\n')
    totalChars += block.length
    parts.push(block)
  }

  const suffix =
    totalChars >= CONTENT_MODE_MAX_CHARS
      ? '\n... [结果已截断，请缩小搜索范围或切换为 files_with_matches 模式]'
      : ''

  return parts.join('\n\n') + suffix
}
