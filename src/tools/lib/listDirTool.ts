import * as fs from 'node:fs/promises'
import type { ModuxTool } from '../types'
import { resolveWorkspacePath } from '../utils'

// ***
// 工具：列出目录条目（自动过滤无关目录）
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 列目录最多返回条目数 */
const MAX_DIR_ENTRIES = 100

/** 列目录时自动跳过的无关目录 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.vscode', 'out'])

// ── list_dir ──────────────────────────────────────────────────────────────────

interface ListDirInput {
  path: string
}

export const name = 'list_dir'

export const listDirTool: ModuxTool = {
  name,
  description:
    'List the contents of a directory in the workspace (files and subdirectories). ' +
    'Automatically skips .git, node_modules, dist, and other irrelevant directories. Returns up to 100 entries.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path relative to the workspace root. Use "." for the root directory.',
      },
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
      return `Failed to list directory "${dirPath}": ${msg}`
    }

    if (entries.length === 0) return `Directory "${dirPath}" is empty.`

    return `Contents of "${dirPath}" (${entries.length} entries):\n${entries.join('\n')}`
  },
}
