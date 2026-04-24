import * as vscode from 'vscode'
import { AGENT_ID } from '../shared/constants'
import { handleChatRequest } from '../chat/handler'
import { log } from '../shared/logger'

/**
 * Provider 层：向 Copilot 注册 modux-agent Chat Participant
 *
 * 职责边界：
 * - 唯一知道 vscode.chat API 的地方
 * - 只负责注册，不含任何请求处理逻辑
 */
export function registerAgent(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(AGENT_ID, handleChatRequest)

  // 推入订阅列表，扩展停用时自动 dispose
  context.subscriptions.push(participant)

  log(`Chat Participant 已注册：${AGENT_ID}`)
}
