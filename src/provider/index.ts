import * as vscode from 'vscode'
import { AGENT_ID } from '../shared/constants'
import { handleChatRequest } from '../chat/handler'
import { ModuxModelProvider } from './lm-provider'
import { log } from '../shared/logger'

/**
 * Provider 层：向 Copilot 注册 modux-agent
 *
 * 同时注册两种接入方式：
 * 1. Chat Participant（@modux-agent）：用户通过 @ 显式调用
 * 2. Language Model Provider（模型下拉列表）：用户从 Copilot Chat 的
 *    模型选择器中选中 "modux-agent" 后，所有对话均通过本 provider 处理
 *
 * 职责边界：
 * - 唯一知道 vscode.chat / vscode.lm 注册 API 的地方
 * - 只负责注册，不含任何请求处理逻辑
 */
export function registerAgent(context: vscode.ExtensionContext): void {
  // 1. 注册 Chat Participant（@modux-agent）
  const participant = vscode.chat.createChatParticipant(AGENT_ID, handleChatRequest)
  context.subscriptions.push(participant)
  log(`Chat Participant 已注册：${AGENT_ID}`)

  // 2. 注册 Language Model Provider（Copilot Chat 模型下拉列表）
  //    vendor 必须与 package.json contributes.languageModelChatProviders[].vendor 一致
  const lmProvider = vscode.lm.registerLanguageModelChatProvider('modux', new ModuxModelProvider())
  context.subscriptions.push(lmProvider)
  log('Language Model Provider 已注册：vendor=modux')
}
