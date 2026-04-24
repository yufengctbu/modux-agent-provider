import * as vscode from 'vscode'
import { NO_MODEL_MESSAGE } from '../types'
import { log } from '../logger'

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
  log(`收到消息：${request.prompt}`)

  // 选取可用的 Copilot 语言模型（优先使用 gpt-4o 系列）
  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o',
  })

  if (models.length === 0) {
    log('警告：未找到可用的语言模型')
    stream.markdown(NO_MODEL_MESSAGE)
    return
  }

  const model = models[0]
  log(`使用模型：${model.name}`)

  // 将用户消息包装为 LM 消息格式
  const messages = [vscode.LanguageModelChatMessage.User(request.prompt)]

  try {
    // 向模型发送请求并流式输出响应
    const response = await model.sendRequest(messages, {}, token)
    for await (const chunk of response.text) {
      stream.markdown(chunk)
    }
    log('响应完成')
  } catch (err) {
    // vscode.LanguageModelError 是 LM API 的专用错误类型
    // 常见原因：用户未授权、配额不足、请求被取消等
    if (err instanceof vscode.LanguageModelError) {
      log(`LM 错误 [${err.code}]：${err.message}`)
      stream.markdown(`**请求失败**（${err.code}）：${err.message}`)
    } else {
      // 非预期错误向上抛出，让 VS Code 统一处理
      throw err
    }
  }
}
