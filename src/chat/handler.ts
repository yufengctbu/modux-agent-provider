import * as vscode from 'vscode'
import { runAgentLoop } from './loop'
import { log } from '../shared/logger'

/**
 * Chat 层入口：解析 VS Code 原始请求，启动 Agent Loop
 *
 * 职责边界：
 * - 负责 vscode.Chat* 类型的解包与传递
 * - 不含任何业务逻辑（业务在 loop.ts）
 * - 不直接接触 LLM API（LLM 在 llm/client.ts）
 */
export async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  log(`收到消息：${request.prompt}`)

  await runAgentLoop(request.prompt, context, stream, token)

  log('handleChatRequest 完成')
}
