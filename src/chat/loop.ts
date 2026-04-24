import * as vscode from 'vscode'
import { selectModel, requestStream } from '../llm/client'
import { ContextBuilder } from './context'
import { log } from '../shared/logger'
import { MAX_LOOP_ROUNDS } from '../shared/constants'

/** 未找到可用模型时向用户展示的提示，属于 chat 层的用户面向文案 */
const NO_MODEL_MESSAGE = '未找到可用的语言模型。请确保已安装并启用 GitHub Copilot 扩展。'

/**
 * Agent Loop 的运行结果
 * isDone=true 时输出最终答案，isDone=false 时表示需要继续循环
 *
 * 扩展点：当需要接入工具调用（函数调用、代码执行等）时，
 * 在 isDone=false 的分支中补充 action 字段，由 loop 驱动执行。
 */
interface LoopResult {
  isDone: boolean
  output: string
}

/**
 * 解析 LLM 单轮输出，判断任务是否已完成
 *
 * 当前实现：每轮视为完成（直接输出）。
 * 扩展点：可在此处解析 LLM 输出中的特定标记（如 <tool_call>、CONTINUE 等），
 * 将 isDone 设为 false 并填入 action，实现多轮工具调用。
 */
function parseResponse(text: string): LoopResult {
  return { isDone: true, output: text }
}

/**
 * Agent 核心循环
 *
 * 职责：
 * 1. 维护每轮循环的状态（轮次、上下文）
 * 2. 驱动 context → LLM → 解析 → （执行动作）→ 下一轮
 * 3. 将最终结果流式写入 stream
 *
 * @param initialPrompt - 用户本轮输入的原始文本
 * @param history       - Copilot Chat 传入的历史上下文
 * @param stream        - 向 Chat 面板写入流式响应
 * @param token         - 取消令牌，用户点击停止时中断循环
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

    // 构建本轮完整消息列表（历史 + 当前 prompt）
    const messages = contextBuilder.build(initialPrompt)

    // 收集 LLM 完整输出，用于 parseResponse 判断是否完成
    // 最终轮（isDone=true）同步流式输出，非最终轮（内部推理）不输出
    let fullText = ''
    let isDonePending = false
    try {
      const textStream = await requestStream(model, messages, token)
      for await (const chunk of textStream) {
        fullText += chunk
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        log(`[Loop] LM 错误 [${err.code}]：${err.message}`)
        stream.markdown(`**请求失败**（${err.code}）：${err.message}`)
        return
      }
      throw err
    }

    const result = parseResponse(fullText)
    isDonePending = result.isDone
    log(`[Loop] 第 ${round} 轮完成，isDone=${isDonePending}`)

    // 将本轮回复追加进上下文，下一轮可见
    contextBuilder.appendAssistant(fullText)

    if (isDonePending) {
      // 任务完成：一次性输出最终答案
      // 扩展点：若需要真正的流式体验，可将 requestStream 的 for-await 与
      // stream.markdown(chunk) 合并，但需要 parseResponse 支持流式判断
      stream.markdown(result.output)
      break
    }

    // 扩展点：任务未完成时，在此处执行 action（调工具、读文件等）
    // const observation = await executeAction(result.action, stream)
    // contextBuilder.appendObservation(observation)
  }
}
