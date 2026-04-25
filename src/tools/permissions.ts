import * as vscode from 'vscode'

// ***
// 运行时权限管理
//
// 设计参考 claude-code 的"先询问，记住选择"模式：
//   - 第一次执行某命令时弹框请求用户确认
//   - 用户可选"始终允许"，将命令前缀保存到 workspaceState
//   - 后续相同前缀的命令直接放行，无需再次确认
//
// 存储位置：ExtensionContext.workspaceState（按工作区隔离，重启后保留）
// 撤销方式：调用 revokeCommandPrefix() 或清空 workspaceState 对应键
// ***

const WORKSPACE_STATE_KEY = 'modux.allowedCommandPrefixes'

let _context: vscode.ExtensionContext | undefined

/** 在扩展激活时调用，注入 ExtensionContext 以访问 workspaceState */
export function initPermissions(context: vscode.ExtensionContext): void {
  _context = context
}

/**
 * 向用户请求执行 shell 命令的权限。
 *
 * 决策流程：
 *   1. 若命令前缀已在本工作区的允许列表中 → 直接放行
 *   2. 否则弹出确认框：
 *      - "允许 (仅此次)"   → 放行，不记录
 *      - "始终允许 <前缀>" → 放行，并将前缀写入 workspaceState
 *      - "拒绝" / 关闭    → 拒绝
 *
 * @returns true 表示允许执行，false 表示拒绝
 */
export async function requestCommandPermission(command: string): Promise<boolean> {
  const prefix = extractCommandPrefix(command)

  if (isAllowed(prefix)) {
    return true
  }

  const alwaysAllowLabel = `始终允许 "${prefix}" 命令`

  const choice = await vscode.window.showWarningMessage(
    'Agent 请求执行 shell 命令',
    {
      modal: true,
      detail: command,
    },
    '允许 (仅此次)',
    alwaysAllowLabel,
    '拒绝',
  )

  if (choice === '允许 (仅此次)') {
    return true
  }

  if (choice === alwaysAllowLabel) {
    saveAllowedPrefix(prefix)
    return true
  }

  // 用户点击"拒绝"或直接关闭对话框
  return false
}

/** 获取当前工作区已保存的允许命令前缀列表 */
export function getAllowedCommandPrefixes(): string[] {
  return _context?.workspaceState.get<string[]>(WORKSPACE_STATE_KEY) ?? []
}

/** 撤销某个命令前缀的始终允许授权 */
export function revokeCommandPrefix(prefix: string): void {
  if (!_context) return
  const updated = getAllowedCommandPrefixes().filter((p) => p !== prefix)
  _context.workspaceState.update(WORKSPACE_STATE_KEY, updated)
}

// ── 内部辅助 ──────────────────────────────────────────────────────────────────

/** 提取命令的第一个词（可执行文件名）作为匹配前缀 */
function extractCommandPrefix(command: string): string {
  return command.trim().split(/\s+/)[0] ?? command.trim()
}

function isAllowed(prefix: string): boolean {
  return getAllowedCommandPrefixes().includes(prefix)
}

function saveAllowedPrefix(prefix: string): void {
  if (!_context) return
  const allowed = getAllowedCommandPrefixes()
  if (!allowed.includes(prefix)) {
    _context.workspaceState.update(WORKSPACE_STATE_KEY, [...allowed, prefix])
  }
}
