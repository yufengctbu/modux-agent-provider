import { exec } from 'node:child_process'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { config } from '../config'
import type { ModuxTool } from './types'

// ***
// 工具组：Shell 命令执行
//   - run_command  在工作区根目录执行任意 shell 命令
//
// 安全说明：
//   - 此工具默认关闭（config.tools.runCommand.enabled = false）
//   - 启用前请确认工作区可信，并了解命令执行的潜在风险
//   - 超时时间可在 config.tools.runCommand.timeoutMs 中配置
// ***

/** 未配置时的默认超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000

/** 命令输出最大字符数，超出部分截断，防止大量日志撑爆 token */
const MAX_OUTPUT_CHARS = 4_000

// ── run_command ───────────────────────────────────────────────────────────────

interface RunCommandInput {
  command: string
  cwd?: string
}

export const runCommandTool: ModuxTool = {
  name: 'run_command',
  description:
    'Execute a shell command in the workspace directory and return the combined stdout/stderr output. ' +
    'Use the cwd parameter to run in a subdirectory (relative path). Output longer than 4000 characters is automatically truncated. ' +
    'This tool is disabled by default; only enable it in trusted workspaces.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: {
        type: 'string',
        description:
          'Working directory for the command, relative to the workspace root (optional, defaults to workspace root)',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  maxResultChars: MAX_OUTPUT_CHARS,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { command, cwd: relativeCwd } = input as RunCommandInput

    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      return 'Failed to execute: no workspace folder found. Please open a folder first.'
    }
    const workspaceRoot = folders[0].uri.fsPath

    // 验证 cwd 不超出工作区根目录（防止路径穿越攻击）
    let execCwd = workspaceRoot
    if (relativeCwd) {
      const resolved = path.resolve(workspaceRoot, relativeCwd)
      if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
        return `Failed to execute: cwd "${relativeCwd}" is outside the workspace root. Access denied.`
      }
      execCwd = resolved
    }

    const timeoutMs =
      (config.tools as Record<string, { enabled: boolean; timeoutMs?: number }>).runCommand
        ?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<string>((resolve) => {
      const child = exec(command, { cwd: execCwd, timeout: timeoutMs }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trimEnd()

        if (error && error.killed) {
          resolve(
            `Command timed out (${timeoutMs}ms): ${command}\n` +
              (output ? `Output so far:\n${truncate(output)}` : '(no output)'),
          )
          return
        }

        const exitInfo = error ? `\n[exit code ${error.code ?? '?'}]` : ''
        const result = output ? truncate(output) + exitInfo : `(no output)${exitInfo}`
        resolve(result)
      })

      // 用户取消时终止子进程
      token.onCancellationRequested(() => {
        child.kill()
        resolve(`Command cancelled: ${command}`)
      })
    })
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 截断超长输出，保留末尾内容（通常包含最有价值的错误信息） */
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const kept = output.slice(-MAX_OUTPUT_CHARS)
  return `... [output truncated, showing last ${MAX_OUTPUT_CHARS} characters]\n${kept}`
}
