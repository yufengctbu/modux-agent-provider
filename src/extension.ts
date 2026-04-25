import * as vscode from 'vscode'
import { registerAgent } from './provider/index'
import { registerLogger, log } from './shared/logger'

/**
 * 扩展激活入口
 * VS Code 在满足 activationEvents 时自动调用此函数
 */
export function activate(context: vscode.ExtensionContext): void {
  registerLogger(context) // 注册日志
  log('modux-agent 已激活')

  registerAgent(context) // 注册 Agent
}

/**
 * 扩展注销入口
 * VS Code 卸载扩展时自动调用，资源清理由 context.subscriptions 自动完成
 */
export function deactivate(): void {}
