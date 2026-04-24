import * as vscode from 'vscode'
import { selectModel, sendChatRequest } from '../llm/client'
import { ContextBuilder } from './context'
import { AVAILABLE_TOOLS, executeTool } from './tools/registry'
import { log } from '../shared/logger'
import { MAX_LOOP_ROUNDS } from '../shared/constants'

/** 未找到可用模型时向用户展示的提示，属于 chat 层的用户面向文案 */
const NO_MODEL_MESSAGE = '未找到可用的语言模型。请确保已安装并启用 GitHub Copilot 扩展。'

/**
 * Agent 核心循环
 *
 * 每轮流程：
 *   1. 构建消息列表（第 1 轮含用户 prompt，后续轮次含工具结果）
 *   2. 调用 LLM，按 Part 类型分流处理：
 *      - LanguageModelTextPart     → 收集文本
 *      - LanguageModelToolCallPart → 收集工具调用请求
 *   3. 判断是否继续：
 *      - 无工具调用 → 输出最终文本，结束
 *      - 有工具调用 → 执行工具，追加结果到上下文，进入下一轮
 *
 * @param initialPrompt - 用户本轮输入的原始文本
 * @param history       - Copilot Chat 传入的历史上下文
 * @param stream        - 向 Chat 面板写入响应
 * @param token         - 取消令牌
 */
export async function runAgentLoop(
  initialPrompt: string,
  history: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const model = await selectModel()
  if (!model) {
    stream.markdown(NO_MODEL_MESSAGE)
    return
  }

  const contextBuilder = new ContextBuilder(history)

  for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
    if (token.isCancellationRequested) {
      log('[Loop] 用户取消')
      break
    }

    log(`[Loop] 第 ${round} 轮开始`)

    // 第 1 轮追加用户 prompt，后续轮次消息列表中已含工具结果，无需重复追加
    const messages =
      round === 1 ? contextBuilder.build(initialPrompt) : contextBuilder.buildForContinuation()

    // ── 单次 LLM 调用，按 Part 类型分流收集 ──────────────────────────────────
    const textParts: vscode.LanguageModelTextPart[] = []
    const toolCalls: vscode.LanguageModelToolCallPart[] = []

    try {
      const response = await sendChatRequest(model, messages, AVAILABLE_TOOLS, token)
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part)
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part)
        }
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        log(`[Loop] LM 错误 [${err.code}]：${err.message}`)
        stream.markdown(`**请求失败**（${err.code}）：${err.message}`)
        return
      }
      throw err
    }

    // 将本轮 assistant 消息（文本 + 工具调用）写入上下文，下一轮可见
    contextBuilder.appendAssistantWithToolCalls(textParts, toolCalls)
    log(`[Loop] 第 ${round} 轮完成，文本段=${textParts.length}，工具调用=${toolCalls.length}`)

    // ── 无工具调用：任务完成，输出最终文本 ───────────────────────────────────
    if (toolCalls.length === 0) {
      stream.markdown(textParts.map((p) => p.value).join(''))
      break
    }

    // ── 有工具调用：执行每个工具，收集结果，追加后继续下一轮 ─────────────────
    const toolResults: vscode.LanguageModelToolResultPart[] = []

    for (const call of toolCalls) {
      try {
        const resultText = await executeTool(call.name, call.input, token)
        toolResults.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(resultText),
          ]),
        )
        log(`[Loop] 工具 ${call.name} 完成`)
      } catch (err) {
        // 工具执行失败不终止循环，将错误信息回传给 LLM，由 LLM 决定如何处理
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`[Loop] 工具 ${call.name} 失败：${errMsg}`)
        toolResults.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(`执行失败：${errMsg}`),
          ]),
        )
      }
    }

    contextBuilder.appendToolResults(toolResults)
  }
}
