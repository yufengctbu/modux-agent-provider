import * as vscode from 'vscode'
import { selectModel, sendChatRequest } from '../llm/client'
import { config } from '../config'
import { ContextBuilder } from './context'
import { toolsManager } from '../tools'
import type { WorkspaceContext } from './workspace'
import { log } from '../shared/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Agent 核心循环
//
// 每轮流程：
//   1. 构建消息列表（第 1 轮含用户 prompt，后续轮次含工具结果）
//   2. 调用 LLM，按 Part 类型分流处理：
//      - LanguageModelTextPart     → 实时流式输出 + 收集
//      - LanguageModelToolCallPart → 收集工具调用请求
//   3. 判断是否继续：
//      - 无工具调用 → 结束（文本已流式输出）
//      - 有工具调用 → 执行工具（并发安全的只读工具批量并发执行），追加结果，进入下一轮
//
// Phase 5 并发：partitionToolCalls() 将连续只读工具分为一批并发执行，
//              写工具（isReadOnly: false）仍串行执行，保证执行顺序正确。
//              最终结果按工具调用的原始顺序重新排列，确保消息序列合法。
// ─────────────────────────────────────────────────────────────────────────────

/** 未找到可用模型时向用户展示的提示 */
const NO_MODEL_MESSAGE = '未找到可用的语言模型。请确保已安装并启用 GitHub Copilot 扩展。'

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * 工具调用执行批次
 *
 * concurrent: true  → 批内工具并发执行（全部为只读工具）
 * concurrent: false → 批内工具串行执行（含写工具）
 */
interface ToolCallBatch {
  readonly calls: vscode.LanguageModelToolCallPart[]
  readonly concurrent: boolean
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * Agent 核心循环
 *
 * @param initialPrompt 用户本轮输入的原始文本
 * @param history       Copilot Chat 传入的历史上下文
 * @param stream        向 Chat 面板写入响应
 * @param token         取消令牌
 * @param wsCtx         工作区上下文（由 handler.ts 采集后传入）
 */
export async function runAgentLoop(
  initialPrompt: string,
  history: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  wsCtx: WorkspaceContext,
): Promise<void> {
  const model = await selectModel()
  if (!model) {
    stream.markdown(NO_MODEL_MESSAGE)
    return
  }

  const contextBuilder = new ContextBuilder(wsCtx, history)
  const maxRounds = config.agent.maxLoopRounds

  for (let round = 1; round <= maxRounds; round++) {
    if (token.isCancellationRequested) {
      log('[Loop] 用户取消')
      break
    }

    log(`[Loop] 第 ${round} 轮开始`)

    // 构建消息列表：第 1 轮追加用户 prompt，后续轮次工具结果已在列表中
    const messages =
      round === 1
        ? await contextBuilder.buildForFirstRound(initialPrompt)
        : contextBuilder.buildForContinuationRound()

    // ── 单次 LLM 调用，按 Part 类型分流收集 ──────────────────────────────────
    const textParts: vscode.LanguageModelTextPart[] = []
    const toolCalls: vscode.LanguageModelToolCallPart[] = []

    try {
      const response = await sendChatRequest(
        model,
        messages,
        toolsManager.getAvailableTools(),
        token,
      )
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part)
          // 实时流式输出文本（无论是否有工具调用，让用户看到 LLM 的推理过程）
          stream.markdown(part.value)
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part)
        }
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        log(`[Loop] LM 错误 [${err.code}]：${err.message}`)
        stream.markdown(`\n\n**请求失败**（${err.code}）：${err.message}`)
        return
      }
      throw err
    }

    // 将本轮 assistant 消息（文本 + 工具调用）写入上下文
    contextBuilder.appendAssistantTurn(textParts, toolCalls)
    log(`[Loop] 第 ${round} 轮完成，文本段=${textParts.length}，工具调用=${toolCalls.length}`)

    // ── 无工具调用：任务完成，结束循环 ───────────────────────────────────────
    if (toolCalls.length === 0) {
      break
    }

    // ── 有工具调用：分批执行，收集结果 ───────────────────────────────────────
    const toolResults = await executeToolCallsInBatches(toolCalls, stream, token)
    contextBuilder.appendToolResults(toolResults)

    // 到达最大轮次：修复可能存在的孤儿 ToolCallPart，然后退出
    if (round === maxRounds) {
      log(`[Loop] 已达最大轮次 ${maxRounds}，强制结束`)
      contextBuilder.ensureToolResultsComplete()
      stream.markdown('\n\n*（Agent 已达到最大轮次上限，任务可能未完成）*')
    }
  }
}

// ── 工具执行 ──────────────────────────────────────────────────────────────────

/**
 * 分批执行工具调用，保持结果顺序与调用顺序一致
 *
 * Phase 5 并发策略（对应 Claude Code processToolResults 中的并发优化）：
 *   - 按工具调用顺序分组：连续的只读工具为一批（并发），遇到写工具则起一个新批（串行）
 *   - 批内只读工具 Promise.all 并发，最大化吞吐；写工具严格串行，避免文件竞争
 *   - 最终结果顺序与原始工具调用顺序一致（通过 indexedResults + sort 实现）
 *
 * @returns ToolResultPart 列表，顺序与 toolCalls 一致
 */
async function executeToolCallsInBatches(
  toolCalls: vscode.LanguageModelToolCallPart[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResultPart[]> {
  const batches = partitionToolCalls(toolCalls)
  // indexedResults 保存 [原始索引, ToolResultPart]，最终排序还原顺序
  const indexedResults: Array<[number, vscode.LanguageModelToolResultPart]> = []
  let currentIndex = 0

  for (const batch of batches) {
    if (batch.concurrent) {
      // 并发执行批（只读工具）
      log(`[Loop] 并发执行 ${batch.calls.length} 个只读工具`)
      const results = await Promise.all(
        batch.calls.map((call, i) => executeSingleTool(call, currentIndex + i, stream, token)),
      )
      indexedResults.push(...results)
    } else {
      // 串行执行批（写工具）
      for (let i = 0; i < batch.calls.length; i++) {
        const result = await executeSingleTool(batch.calls[i], currentIndex + i, stream, token)
        indexedResults.push(result)
      }
    }

    currentIndex += batch.calls.length
  }

  // 按原始顺序排序，确保 ToolResultPart 与 ToolCallPart 的 callId 配对关系正确
  indexedResults.sort(([a], [b]) => a - b)
  return indexedResults.map(([, result]) => result)
}

/**
 * 执行单个工具调用并返回 [原始索引, ToolResultPart]
 *
 * 工具失败时不终止循环，而是将错误信息作为 ToolResultPart 回传给 LLM，
 * 让 LLM 决定如何处理（重试、换方案、或向用户报告）。
 */
async function executeSingleTool(
  call: vscode.LanguageModelToolCallPart,
  index: number,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<[number, vscode.LanguageModelToolResultPart]> {
  // 展示工具调用进度（临时 spinner，不影响最终输出）
  stream.progress(`调用工具：${call.name}`)

  try {
    const resultText = await toolsManager.execute(call.name, call.input, token)
    log(`[Loop] 工具 ${call.name} 执行成功`)
    return [
      index,
      new vscode.LanguageModelToolResultPart(call.callId, [
        new vscode.LanguageModelTextPart(resultText),
      ]),
    ]
  } catch (err) {
    // 工具失败：回传错误信息，让 LLM 决定如何处理
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`[Loop] 工具 ${call.name} 执行失败：${errMsg}`)
    return [
      index,
      new vscode.LanguageModelToolResultPart(call.callId, [
        new vscode.LanguageModelTextPart(`Tool execution failed: ${errMsg}`),
      ]),
    ]
  }
}

// ── 工具批次分组 ──────────────────────────────────────────────────────────────

/**
 * 将工具调用列表分组为顺序执行批次
 *
 * 分组规则（贪心算法，O(n)）：
 *   - 连续的只读工具（isReadOnly: true）归入同一批，标记为 concurrent: true
 *   - 每个写工具（isReadOnly: false）独占一批，标记为 concurrent: false
 *   - 未注册工具视为写工具（保守策略）
 *
 * 示例：
 *   [read, read, write, read] → [{concurrent:true,[read,read]}, {concurrent:false,[write]}, {concurrent:true,[read]}]
 */
function partitionToolCalls(toolCalls: vscode.LanguageModelToolCallPart[]): ToolCallBatch[] {
  if (toolCalls.length === 0) return []

  const batches: ToolCallBatch[] = []
  let currentBatch: vscode.LanguageModelToolCallPart[] = []
  let currentIsReadOnly: boolean | null = null

  for (const call of toolCalls) {
    const tool = toolsManager.findTool(call.name)
    const isReadOnly = tool?.isReadOnly ?? false // 未知工具保守视为写操作

    if (currentIsReadOnly === null) {
      // 第一个工具：初始化当前批
      currentBatch = [call]
      currentIsReadOnly = isReadOnly
    } else if (isReadOnly && currentIsReadOnly) {
      // 连续只读工具：合并到当前批
      currentBatch.push(call)
    } else {
      // 遇到不同类型：提交当前批，开始新批
      batches.push({ calls: currentBatch, concurrent: currentIsReadOnly })
      currentBatch = [call]
      currentIsReadOnly = isReadOnly
    }
  }

  // 提交最后一批
  if (currentBatch.length > 0 && currentIsReadOnly !== null) {
    batches.push({ calls: currentBatch, concurrent: currentIsReadOnly })
  }

  return batches
}
