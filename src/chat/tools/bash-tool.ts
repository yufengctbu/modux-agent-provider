import { exec } from 'child_process'
import * as vscode from 'vscode'
import { config } from '../../config'
import type { ModuxTool } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 工具区域：Shell 命令执行
//   - run_command  在工作区根目录执行任意 shell 命令
//
// 安全说明：
//   - 此工具默认关闭（config.tools.runCommand.enabled = false）
//   - 启用前请确认工作区可信，并了解命令执行的潜在风险
//   - 超时时间可在 config.tools.runCommand.timeoutMs 中配置
// ─────────────────────────────────────────────────────────────────────────────

/** 默认超时时间（毫秒），在 config 未配置时使用 */
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
    '在工作区目录中执行 shell 命令，返回 stdout 和 stderr 的合并输出。' +
    '可通过 cwd 指定子目录（相对路径）。输出超过 4000 字符时自动截断。' +
    '此工具默认关闭，启用前确认工作区可信。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: {
        type: 'string',
        description: '命令执行目录（相对于工作区根目录，可选，默认为工作区根目录）',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  maxResultChars: MAX_OUTPUT_CHARS,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { command, cwd: relativeCwd } = input as RunCommandInput

    // 解析工作目录
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      return '执行失败：未找到工作区，请先打开一个文件夹。'
    }
    const workspaceRoot = folders[0].uri.fsPath
    const execCwd = relativeCwd
      ? require('path').resolve(workspaceRoot, relativeCwd)
      : workspaceRoot

    const timeoutMs =
      (config.tools as Record<string, { enabled: boolean; timeoutMs?: number }>).runCommand
        ?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<string>((resolve) => {
      const child = exec(command, { cwd: execCwd, timeout: timeoutMs }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trimEnd()

        if (error && error.killed) {
          resolve(
            `命令超时（${timeoutMs}ms）：${command}\n` +
              (output ? `已输出：\n${truncate(output)}` : '（无输出）'),
          )
          return
        }

        const exitInfo = error ? `\n[退出码 ${error.code ?? '?'}]` : ''
        const result = output ? truncate(output) + exitInfo : `（无输出）${exitInfo}`
        resolve(result)
      })

      // 用户取消时终止子进程
      token.onCancellationRequested(() => {
        child.kill()
        resolve(`命令已取消：${command}`)
      })
    })
  },
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 截断超长输出，保留末尾内容（命令输出的末尾通常包含最关键的错误信息） */
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const kept = output.slice(-MAX_OUTPUT_CHARS)
  return `... [输出已截断，仅显示末尾 ${MAX_OUTPUT_CHARS} 字符]\n${kept}`
}
