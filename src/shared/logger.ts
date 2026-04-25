import * as vscode from 'vscode'

/**
 * 全局 LogOutputChannel 实例
 * 在 VS Code 底部 "输出" 面板的 "modux-agent" 频道中显示日志
 * 使用 LogOutputChannel（VS Code 1.74+）支持 info / warn / error / debug 颜色区分
 */
let _channel: vscode.LogOutputChannel | undefined

/**
 * 注册日志频道，应在扩展激活时调用一次
 * 将 channel 推入 subscriptions，扩展停用时自动销毁
 */
export function registerLogger(context: vscode.ExtensionContext): void {
  _channel = vscode.window.createOutputChannel('modux-agent', { log: true })
  context.subscriptions.push(_channel)
}

/** 普通信息（灰色） */
export function log(message: string): void {
  _channel?.info(message)
}

/** 警告（黄色） */
export function logWarn(message: string): void {
  _channel?.warn(message)
}

/** 错误（红色） */
export function logError(message: string): void {
  _channel?.error(message)
}

/** 调试信息（浅灰，默认隐藏，需将频道级别设为 Debug 才可见） */
export function logDebug(message: string): void {
  _channel?.debug(message)
}
