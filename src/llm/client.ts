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
 * 向指定模型发送消息并返回异步文本流
 *
 * 此函数无感知 loop 的存在，只负责单次 LLM 调用。
 * 错误由调用方（loop）统一捕获处理。
 */
export async function requestStream(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<AsyncIterable<string>> {
  const response = await model.sendRequest(messages, {}, token)
  return response.text
}
