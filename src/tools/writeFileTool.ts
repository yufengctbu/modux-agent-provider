import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ModuxTool } from './types'
import { resolveWorkspacePath } from './utils'

// ***
// 工具：全量写文件
//   - write_file  创建新文件或完整覆写现有文件
//
// 注意：仅用于新建或完整重写；局部修改请使用 edit_file（str_replace）。
// ***

// ── write_file ────────────────────────────────────────────────────────────────

interface WriteFileInput {
  path: string
  content: string
}

export const writeFileTool: ModuxTool = {
  name: 'write_file',
  description:
    'Write content to a file in the workspace. Use only for creating new files or completely rewriting existing ones. ' +
    'For targeted modifications to existing files, prefer edit_file (str_replace) to avoid accidental overwrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root' },
      content: { type: 'string', description: 'Full file content to write' },
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
      return `Failed to write file "${filePath}": ${msg}`
    }

    return `OK: Wrote "${filePath}" (${content.length} characters).`
  },
}
