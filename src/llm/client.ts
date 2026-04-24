import * as vscode from 'vscode'
import { log } from '../shared/logger'

/**
 * LLM 模型配置，仅 llm 层使用
 * 修改此处即可切换底层模型，无需改动其他层
 */
const MODEL_CONFIG = {
  /** 模型提供方，固定为 copilot */
  vendor: 'copilot',
  /** 模型系列，可选值如 'gpt-4o' | 'gpt-4o-mini' | 'claude-sonnet-4-5' */
  family: 'gpt-4o',
} as const

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
