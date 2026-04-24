import * as vscode from 'vscode'
import { AGENT_ID } from '../types'
import { handleChatRequest } from './handler'

/**
 * 注册 modux-agent Chat Participant
 *
 * 将 handleChatRequest 绑定为处理函数，并将 participant 加入
 * context.subscriptions，确保扩展注销时自动释放资源。
 */
export function registerAgent(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(AGENT_ID, handleChatRequest)

  // 将参与者推入订阅列表，扩展停用时自动 dispose
  context.subscriptions.push(participant)
}
