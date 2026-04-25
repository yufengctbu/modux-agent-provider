import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ModuxTool } from './types'
import { resolveWorkspacePath } from './utils'

// ***
// 工具：LSP 语言服务信息查询
//   - lsp_info  查询当前打开/指定文件的语言服务信息：诊断（errors/warnings）、定义、引用
//
// 为什么必要（对 coding agent 的价值）：
//   - 诊断（getDiagnostics）：在修改代码后立刻确认是否引入/消除了编译错误，无需 run_command 跑构建
//   - 定义（executeDefinitionProvider）：快速跳到符号的声明处，比 search_code 精准
//   - 引用（executeReferenceProvider）：评估重构影响范围
//
// 实现：基于 VS Code 内置命令接口（vscode.executeXxxProvider），
//       任何已安装的语言扩展（TS/Python/Go/Rust/...）都会自动参与。
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 诊断结果最大返回条数，避免大量 warning 撑爆 token */
const MAX_DIAGNOSTICS = 50

/** 定义/引用结果最大返回条数 */
const MAX_LOCATIONS = 30

/** 整体输出最大字符数 */
const MAX_RESULT_CHARS = 6_000

/** 严重程度映射：0=Error,1=Warning,2=Information,3=Hint */
const SEVERITY_LABEL = ['ERROR', 'WARN', 'INFO', 'HINT'] as const

// ── 类型 ──────────────────────────────────────────────────────────────────────

type LSPAction = 'diagnostics' | 'definition' | 'references'

interface LspInput {
  /** 操作类型 */
  action: LSPAction
  /** 目标文件相对路径（workspace 根下）。diagnostics 可省略 = 全工作区 */
  path?: string
  /** definition/references 必需：1-based 行号 */
  line?: number
  /** definition/references 必需：0-based 列号（VS Code API 约定） */
  character?: number
}

// ── lsp_info ──────────────────────────────────────────────────────────────────

export const lspTool: ModuxTool = {
  name: 'lsp_info',
  description:
    'Query the VS Code Language Server for diagnostics, definitions, or references. ' +
    'Actions: ' +
    '"diagnostics" — list errors/warnings in a file (or the whole workspace if path is omitted); ' +
    '"definition" — find where a symbol is defined (requires path + line + character); ' +
    '"references" — find all usages of a symbol (requires path + line + character). ' +
    'Use after editing to verify no new errors were introduced, or to navigate code structure without grep.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['diagnostics', 'definition', 'references'],
        description: 'Which LSP query to run',
      },
      path: {
        type: 'string',
        description:
          'Target file path, relative to the workspace root (required for definition/references; optional for diagnostics)',
      },
      line: {
        type: 'number',
        description:
          '1-based line number of the symbol to inspect (required for definition/references)',
      },
      character: {
        type: 'number',
        description:
          '0-based column index of the symbol to inspect (required for definition/references)',
      },
    },
    required: ['action'],
  },
  isReadOnly: true,
  maxResultChars: MAX_RESULT_CHARS,

  async execute(input: unknown): Promise<string> {
    const { action, path: filePath, line, character } = input as LspInput

    switch (action) {
      case 'diagnostics':
        return runDiagnostics(filePath)
      case 'definition':
        return runLocationProvider('definition', filePath, line, character)
      case 'references':
        return runLocationProvider('references', filePath, line, character)
      default:
        return `Unknown action "${action}". Valid actions: diagnostics | definition | references.`
    }
  },
}

// ── diagnostics ───────────────────────────────────────────────────────────────

async function runDiagnostics(filePath: string | undefined): Promise<string> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    return 'Failed: no workspace folder open.'
  }
  const root = folders[0].uri.fsPath

  let entries: [vscode.Uri, readonly vscode.Diagnostic[]][]

  if (filePath) {
    const resolved = resolveWorkspacePath(filePath)
    if (typeof resolved === 'object') return resolved.error
    const uri = vscode.Uri.file(resolved)
    const diags = vscode.languages.getDiagnostics(uri)
    entries = diags.length > 0 ? [[uri, diags]] : []
  } else {
    // 全工作区诊断（返回所有已打开/分析过文件的诊断）
    entries = vscode.languages.getDiagnostics()
  }

  if (entries.length === 0) {
    return filePath
      ? `No diagnostics for "${filePath}".`
      : 'No diagnostics in the workspace.'
  }

  const flat: { rel: string; diag: vscode.Diagnostic }[] = []
  for (const [uri, diags] of entries) {
    const rel = toRelPath(uri.fsPath, root)
    for (const d of diags) flat.push({ rel, diag: d })
    if (flat.length >= MAX_DIAGNOSTICS) break
  }

  // 按严重程度排序（Error 优先），截断
  flat.sort((a, b) => a.diag.severity - b.diag.severity)
  const shown = flat.slice(0, MAX_DIAGNOSTICS)

  const lines = shown.map(({ rel, diag }) => {
    const sev = SEVERITY_LABEL[diag.severity] ?? 'UNKNOWN'
    const startLine = diag.range.start.line + 1 // 1-based for output
    const startChar = diag.range.start.character
    const source = diag.source ? ` [${diag.source}]` : ''
    const code = diag.code ? ` (${typeof diag.code === 'object' ? diag.code.value : diag.code})` : ''
    return `${sev}${source}${code}  ${rel}:${startLine}:${startChar}  ${diag.message}`
  })

  const suffix =
    flat.length > MAX_DIAGNOSTICS
      ? `\n... [Showing first ${MAX_DIAGNOSTICS} of ${flat.length} diagnostics]`
      : ''

  return `Diagnostics (${shown.length}):\n${lines.join('\n')}${suffix}`
}

// ── definition / references ───────────────────────────────────────────────────

async function runLocationProvider(
  kind: 'definition' | 'references',
  filePath: string | undefined,
  line: number | undefined,
  character: number | undefined,
): Promise<string> {
  if (!filePath) {
    return `Failed: "path" is required for ${kind}.`
  }
  if (typeof line !== 'number' || typeof character !== 'number') {
    return `Failed: "line" (1-based) and "character" (0-based) are required for ${kind}.`
  }

  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    return 'Failed: no workspace folder open.'
  }
  const root = folders[0].uri.fsPath

  const resolved = resolveWorkspacePath(filePath)
  if (typeof resolved === 'object') return resolved.error

  const uri = vscode.Uri.file(resolved)
  const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, character))

  // VS Code built-in commands return Location[] | LocationLink[]
  const command =
    kind === 'definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider'

  let raw: (vscode.Location | vscode.LocationLink)[]
  try {
    raw = (await vscode.commands.executeCommand(command, uri, position)) ?? []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Failed to query ${kind}: ${msg}`
  }

  if (raw.length === 0) {
    return `No ${kind} found at ${filePath}:${line}:${character}.`
  }

  const locations = raw.slice(0, MAX_LOCATIONS).map((loc) => normalizeLocation(loc, root))

  const lines = locations.map(
    ({ rel, startLine, startChar }) => `${rel}:${startLine}:${startChar}`,
  )

  const suffix =
    raw.length > MAX_LOCATIONS ? `\n... [Showing first ${MAX_LOCATIONS} of ${raw.length}]` : ''

  return `${kind === 'definition' ? 'Definition' : 'References'} (${locations.length}):\n${lines.join('\n')}${suffix}`
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function normalizeLocation(
  loc: vscode.Location | vscode.LocationLink,
  root: string,
): { rel: string; startLine: number; startChar: number } {
  const targetUri = 'targetUri' in loc ? loc.targetUri : loc.uri
  const targetRange = 'targetRange' in loc ? loc.targetRange : loc.range
  return {
    rel: toRelPath(targetUri.fsPath, root),
    startLine: targetRange.start.line + 1, // 1-based
    startChar: targetRange.start.character,
  }
}

/** 绝对路径转相对工作区根的相对路径（POSIX 分隔符） */
function toRelPath(absPath: string, root: string): string {
  if (!root) return absPath
  if (absPath.startsWith(root + path.sep) || absPath.startsWith(root + '/')) {
    return absPath.slice(root.length + 1).replace(/\\/g, '/')
  }
  return absPath.replace(/\\/g, '/')
}
