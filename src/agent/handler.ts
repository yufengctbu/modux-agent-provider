import * as vscode from 'vscode'
import { NO_MODEL_MESSAGE } from '../types'

/**
 * 处理来自 Copilot Chat 的用户消息
 *
 * @param request - 用户请求，包含 prompt 文本和上下文
 * @param _context - 对话历史上下文（本示例暂不使用）
 * @param stream  - 用于向 Chat 面板流式输出内容
 * @param token   - 取消令牌，用户点击停止时触发
 */
export async function handleChatRequest(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  // 选取可用的 Copilot 语言模型（优先使用 gpt-4o 系列）
  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o',
  })

  if (models.length === 0) {
    stream.markdown(NO_MODEL_MESSAGE)
    return
  }

  const model = models[0]

  // 将用户消息包装为 LM 消息格式
  const messages = [vscode.LanguageModelChatMessage.User(request.prompt)]

  // 向模型发送请求并流式输出响应
  const response = await model.sendRequest(messages, {}, token)

  for await (const chunk of response.text) {
    stream.markdown(chunk)
  }
}
