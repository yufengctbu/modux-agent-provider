import * as vscode from 'vscode'

/**
 * 全局 Output Channel 实例
 * 在 VS Code 底部 "输出" 面板的 "modux-agent" 频道中显示日志
 */
let _channel: vscode.OutputChannel | undefined

/**
 * 初始化日志频道，应在扩展激活时调用一次
 * 将 channel 推入 subscriptions，扩展停用时自动销毁
 */
export function initLogger(context: vscode.ExtensionContext): void {
  _channel = vscode.window.createOutputChannel('modux-agent')
  context.subscriptions.push(_channel)
}

/**
 * 向 Output Channel 追加一行带时间戳的日志
 */
export function log(message: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  _channel?.appendLine(`[${ts}] ${message}`)
}
