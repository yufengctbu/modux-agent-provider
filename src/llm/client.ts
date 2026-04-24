import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'

// 底层 LLM 配置从 src/config/config.json 的 llm 字段读取
// 可修改 config.json 中的 vendor / family 切换模型，无需改动此文件
const MODEL_CONFIG = config.llm

/**
 * 选取可用的 Copilot 语言模型
 *
 * 找不到可用模型时返回 undefined，由调用方决定如何向用户反馈。
 */
export async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  // 获取所有可用模型
  const models = await vscode.lm.selectChatModels(MODEL_CONFIG)

  if (models.length === 0) {
    log('警告：未找到可用的语言模型')
    return undefined
  }

  log(`使用模型：${models[0].name}`)
  return models[0]
}

/**
 * 向指定模型发送消息，返回原始响应对象
 *
 * 返回 LanguageModelChatResponse 而非 .text，
 * 使调用方可以同时处理文本片段（TextPart）和工具调用片段（ToolCallPart）。
 *
 * @param tools 本次请求中向 LLM 声明的可用工具列表，空数组表示纯文本对话
 */
export async function sendChatRequest(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  tools: readonly vscode.LanguageModelChatTool[],
  token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChatResponse> {
  return await model.sendRequest(messages, { tools: [...tools] }, token)
}
