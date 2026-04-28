import * as vscode from 'vscode'
import { log } from '../shared/logger'
import { LmProvider } from './LmProvider'

/**
 * Provider 层：向 Copilot 注册 modux-agent
 *
 * 唯一接入方式：Language Model Provider（模型下拉列表）
 * 用户从 Copilot Chat 的模型选择器中选中后，所有对话均通过本 provider 处理。
 *
 * 职责边界：
 * - 唯一知道 vscode.lm 注册 API 的地方
 * - 只负责注册，不含任何请求处理逻辑
 */
export function registerAgent(context: vscode.ExtensionContext): void {
  // 注册 Language Model Provider（Copilot Chat 模型下拉列表）
  //    vendor 必须与 package.json contributes.languageModelChatProviders[].vendor 一致
  const lmProvider = vscode.lm.registerLanguageModelChatProvider('modux', new LmProvider())
  context.subscriptions.push(lmProvider)
  log('Language Model Provider 已注册：vendor=modux')
}
