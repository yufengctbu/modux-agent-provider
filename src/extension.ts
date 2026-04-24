import * as vscode from 'vscode'
import { registerAgent } from './agent/index'
import { initLogger, log } from './logger'

/**
 * 扩展激活入口
 * VS Code 在满足 activationEvents 时自动调用此函数
 */
export function activate(context: vscode.ExtensionContext): void {
  initLogger(context)
  log('modux-agent 已激活')
  registerAgent(context)
}

/**
 * 扩展注销入口
 * VS Code 卸载扩展时自动调用，资源清理由 context.subscriptions 自动完成
 */
export function deactivate(): void {}
