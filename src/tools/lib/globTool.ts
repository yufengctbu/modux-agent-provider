import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ModuxTool, ToolExecuteContext } from '../types'

// ***
// 工具：文件路径发现
//   - find_files  基于 glob 模式匹配工作区中的文件路径
//
// 与 search_code 的区别：
//   find_files  — 按文件名/路径模式查找，不读取内容（速度快，适合"先定位"）
//   search_code — 按内容搜索，适合"按代码片段定位"
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** glob 匹配的最大返回文件数 */
const MAX_GLOB_RESULTS = 200

/** 自动排除的目录（与 search_code 保持一致） */
const EXCLUDE_GLOB = '**/{node_modules,dist,.git,out}/**'

// ── find_files ────────────────────────────────────────────────────────────────

interface FindFilesInput {
  pattern: string
  path?: string
}

export const name = 'find_files'

export const findFilesTool: ModuxTool = {
  name,
  description:
    'Find files in the workspace that match a glob pattern. Returns a sorted list of relative file paths. ' +
    'Use this to discover files by name or extension before reading them. ' +
    'Examples: "**/*.ts" for TypeScript files, "src/**/*.test.*" for test files, "**/package.json" for manifests. ' +
    'For searching file contents by regex, use search_code instead.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g. "**/*.ts", "**/package.json", "src/**")',
      },
      path: {
        type: 'string',
        description:
          'Subdirectory to search within, relative to the workspace root (optional, defaults to workspace root)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,

  async execute(input: unknown, ctx: ToolExecuteContext): Promise<string> {
    const { pattern, path: subPath } = input as FindFilesInput
    const { token } = ctx

    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      return 'Failed: no workspace folder open.'
    }
    const root = folders[0].uri.fsPath

    // 拼接子目录前缀（统一使用正斜杠，兼容 VS Code glob）
    const normalizedSub = subPath?.replace(/\\/g, '/')
    const includePattern = normalizedSub ? `${normalizedSub}/${pattern}` : pattern

    const uris = await vscode.workspace.findFiles(
      includePattern,
      EXCLUDE_GLOB,
      MAX_GLOB_RESULTS,
      token,
    )

    if (uris.length === 0) {
      return `No files found matching "${includePattern}".`
    }

    // 转换为相对路径，Windows 路径统一转为正斜杠
    const relPaths = uris
      .map((uri) => {
        const abs = uri.fsPath
        const rel =
          abs.startsWith(root + path.sep) || abs.startsWith(root + '/')
            ? abs.slice(root.length + 1)
            : abs
        return rel.replace(/\\/g, '/')
      })
      .sort()

    const suffix =
      uris.length >= MAX_GLOB_RESULTS
        ? `\n(Showing first ${MAX_GLOB_RESULTS} results. Refine the pattern to narrow down.)`
        : ''

    return `Found ${relPaths.length} file(s) matching "${includePattern}":\n${relPaths.join('\n')}${suffix}`
  },
}
