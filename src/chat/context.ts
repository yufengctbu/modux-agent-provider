import * as vscode from 'vscode'
import { config } from '../config'
import { buildSystemPrompt } from '../constants/prompts'
import { toolsManager } from '../tools'
import { getActiveAdapter } from '../provider/registry'
import { log } from '../shared/logger'
import { loadMemoryFile, type WorkspaceContext } from './workspace'

// ─────────────────────────────────────────────────────────────────────────────
// ContextBuilder — 对话消息列表的构建与维护
//
// 4 层 Prompt 构建（来自 Claude Code context.ts 设计）：
//   层 1（User 模拟 System）：DEFAULT_SYSTEM_PROMPT + 用户追加 + Memory 文件
//   层 2（Assistant 确认）：  "Understood..."
//   层 3（User 注入上下文）： 工作区信息（git 分支、近期提交、当前状态）
//   层 4：                   历史消息（优先 LLM 摘要压缩，降级时硬截断）
//
// 注：VS Code LM API 不支持 System 角色，用 User 模拟是当前约定做法。
// ─────────────────────────────────────────────────────────────────────────────

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** System Prompt 注入后 Assistant 的确认回复，防止模型在后续重述指令 */
const SYSTEM_ACK = 'Understood. I will follow these instructions.'

/** 历史压缩后 Assistant 的接续确认，防止模型打招呼或重述历史 */
const COMPACT_ACK =
  'Understood. I have the context from the previous session and will continue from where we left off.'

/** LLM 摘要压缩超时（30 秒），超时后自动 abort 降级为截断 */
const COMPACT_TIMEOUT_MS = 30_000

/**
 * 微压缩占位文本：替换掉旧的、冗长的 ToolResultPart 文本主体
 *
 * 目的：保留 callId 与 ToolCallPart 的配对结构（API 合法性），同时把字符数压缩到接近 0。
 * 最近的工具结果保持原样（LLM 当前推理的"工作记忆"），早期工具结果折叠为占位。
 */
const MICRO_COMPACT_TOOL_RESULT_STUB =
  '[Earlier tool result removed by microcompaction to save context tokens. ' +
  'If you need the original content, re-invoke the tool with the same arguments.]'

/**
 * LLM 生成摘要时使用的压缩 Prompt
 * 结构化摘要确保后续对话能接续，不丢失关键任务上下文。
 */
const COMPACT_SYSTEM_PROMPT = `Compress the following conversation history into a structured summary for use in continuing the conversation.

The summary must include the following sections:
1. The user's core request and intent
2. Work completed (files involved, code changes, command execution results)
3. Errors found and how they were fixed
4. Remaining tasks (if any)
5. Current working state (what was being done most recently, where progress stands)

Format: concise, information-dense; retain key code snippets and file paths.`

// ── ContextBuilder ────────────────────────────────────────────────────────────

export class ContextBuilder {
  /**
   * 维护当前 loop 内的消息列表。
   * 初始化时写入层 1–4，之后每轮由 loop.ts 追加 assistant 回复和工具结果。
   */
  private readonly messages: vscode.LanguageModelChatMessage[] = []

  /** 初始化是否已完成（initializeAsync 使用此 Promise 同步） */
  private readonly ready: Promise<void>

  /** 工作区上下文，在 buildForFirstRound 中用于注入动态字段 */
  private readonly wsCtx: WorkspaceContext

  /**
   * @param wsCtx    工作区上下文（git 信息等），稳定部分注入层 3，动态部分注入每轮首个用户消息前
   * @param history  Copilot Chat 传入的对话历史（跨 Turn），注入到层 4
   */
  constructor(wsCtx: WorkspaceContext, history: vscode.ChatContext) {
    this.wsCtx = wsCtx
    this.ready = this.initializeAsync(wsCtx, history)
  }

  /**
   * 异步初始化（加载 Memory 文件 + 构建 4 层 Prompt）
   */
  private async initializeAsync(
    wsCtx: WorkspaceContext,
    history: vscode.ChatContext,
  ): Promise<void> {
    // ── 层 1：System Prompt（用 User 角色模拟） ──────────────────────────────
    const memoryContent = await loadMemoryFile(wsCtx.projectRoot)
    const userSystemPrompt = config.agent.systemPrompt?.trim()

    const systemParts = [buildSystemPrompt(toolsManager.getAvailableTools().map((t) => t.name))]
    if (userSystemPrompt) systemParts.push(`\n\n## User Custom Instructions\n${userSystemPrompt}`)
    if (memoryContent) systemParts.push(`\n\n## Project Instructions (Memory)\n${memoryContent}`)
    const language = config.agent.language?.trim()
    if (language)
      systemParts.push(
        `\n\n# Language\nAlways respond in ${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms, code identifiers, and file paths should remain in their original form.`,
      )

    this.messages.push(vscode.LanguageModelChatMessage.User(systemParts.join('')))

    // ── 层 2：Assistant 确认 ─────────────────────────────────────────────────
    this.messages.push(vscode.LanguageModelChatMessage.Assistant(SYSTEM_ACK))

    // ── 层 3：工作区静态上下文（稳定前缀，最大化 KV 缓存命中） ──────────────
    // 只注入不随日期或 git 操作变化的字段（projectRoot、gitBranch、gitMainBranch）。
    // 动态字段（today、gitStatus、gitRecentCommits）在 buildForFirstRound 中
    // 追加到消息列表末尾，避免破坏层 1-3 的稳定前缀缓存。
    const stableBlock = buildStableWorkspaceBlock(wsCtx)
    this.messages.push(vscode.LanguageModelChatMessage.User(stableBlock))
    this.messages.push(
      vscode.LanguageModelChatMessage.Assistant(
        'Understood. I have the current workspace context.',
      ),
    )

    // ── 层 4：历史消息（含压缩或截断） ──────────────────────────────────────
    const historyMessages = await buildHistoryMessages(history)
    this.messages.push(...historyMessages)
  }

  // ── 消息列表访问 ───────────────────────────────────────────────────────────

  /**
   * 构建首轮消息列表（历史 + 当前用户输入）
   * 只在 loop 第 1 轮调用，等待异步初始化完成后返回。
   *
   * 🪺 设计要点：
   *   - 动态上下文（today、gitStatus）合并到用户 prompt 中，形成一条 User 消息，
   *     同时写入 this.messages，确保后续轮次 LLM 仍能看到原始任务
   *   - 合并后的消息在 Round 2+ 作为稳定前缀的一部分，不会破坏 KV 缓存公共前缀检测
   *     （DeepSeek 在 2 轮后自动识别 Layer1-4 + 此消息作为公共前缀并落盘）
   */
  async buildForFirstRound(userPrompt: string): Promise<vscode.LanguageModelChatMessage[]> {
    await this.ready
    const dynamicBlock = buildDynamicContextBlock(this.wsCtx)
    const fullPrompt = `${dynamicBlock}\n\n${userPrompt}`
    const userMsg = vscode.LanguageModelChatMessage.User(fullPrompt)

    // 将用户消息持久化到消息列表，确保 Round 2+ LLM 仍能看到原始任务
    this.messages.push(userMsg)

    return applyMicrocompaction(this.messages)
  }

  /**
   * 获取当前消息列表（不追加用户输入）
   * 在 loop 第 2+ 轮调用（工具结果已在上一轮末尾追加）。
   */
  buildForContinuationRound(): vscode.LanguageModelChatMessage[] {
    return applyMicrocompaction(this.messages)
  }

  // ── 消息追加 ───────────────────────────────────────────────────────────────

  /**
   * 追加本轮 Assistant 回复（含文本和工具调用部分）
   * 确保下一轮 LLM 能看到"自己说了什么、调用了什么工具"。
   */
  appendAssistantTurn(
    textParts: vscode.LanguageModelTextPart[],
    toolCalls: vscode.LanguageModelToolCallPart[],
  ): void {
    this.messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]))
  }

  /**
   * 追加工具执行结果（以 User 角色的 ToolResultPart 回传）
   * VS Code LM API 规定工具结果以 User 消息形式传递，callId 关联对应的 ToolCallPart。
   */
  appendToolResults(results: vscode.LanguageModelToolResultPart[]): void {
    this.messages.push(vscode.LanguageModelChatMessage.User(results))
  }

  // ── 消息完整性修复 ─────────────────────────────────────────────────────────

  /**
   * 确保消息序列中不存在孤儿 ToolCallPart（无对应 ToolResultPart 的 tool_use 消息）
   *
   * 当 loop 因到达轮次上限、用户取消或异常退出时，最后一条 Assistant 消息可能含
   * 未配对的 ToolCallPart。下一轮 LLM 调用会因消息格式非法而报错。
   *
   * 修复方式：追加一条包含 synthetic ToolResultPart 的 User 消息，保证消息序列合法。
   */
  ensureToolResultsComplete(): void {
    if (this.messages.length === 0) return

    const lastMsg = this.messages[this.messages.length - 1]
    if (lastMsg.role !== vscode.LanguageModelChatMessageRole.Assistant) return

    const orphanCalls = (lastMsg.content as vscode.LanguageModelInputPart[]).filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart,
    )
    if (orphanCalls.length === 0) return

    log(`[Context] 修复 ${orphanCalls.length} 个孤儿 ToolCallPart`)
    const syntheticResults = orphanCalls.map(
      (call) =>
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart('[Tool result missing — loop ended before completion]'),
        ]),
    )
    this.messages.push(vscode.LanguageModelChatMessage.User(syntheticResults))
  }
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

/**
 * 微压缩（microcompaction）
 *
 * 设计来源：Claude Code microCompact —— 在历史消息中扫描 ToolResultPart，
 * 把"足够老 + 足够大"的工具结果替换为占位文本，保留 callId 不变以维持 API 合法性。
 *
 * 与 LLM 摘要压缩的差异：
 *   - LLM 摘要：整段历史 → 一段摘要（损失细粒度，但节省最多 token）
 *   - 微压缩  ：仅替换旧工具结果文本（不动 ToolCall 结构与近期消息）
 *
 * 应用顺序：先做微压缩（轻量、无副作用），再做 LLM 摘要（重量、需调用模型）。
 *
 * 何时不动：
 *   - 最后 N 条 ToolResult（默认 6）：当前推理的工作记忆
 *   - 单条文本 < minChars（默认 400）：压缩反而比原文长
 *   - DataPart（图像）：图像不属于"文本结果"，由独立的剥离逻辑处理
 *
 * 性能：单次扫描 O(n)；返回新的消息数组，不修改原数组（保证 ContextBuilder.messages 不丢数据）。
 */
function applyMicrocompaction(
  messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
): vscode.LanguageModelChatMessage[] {
  if (!config.agent.microcompactEnabled) return [...messages]

  const keepRecent = Math.max(0, config.agent.microcompactKeepRecentToolResults ?? 6)
  const minChars = Math.max(0, config.agent.microcompactMinToolResultChars ?? 400)

  // 第一遍：从右向左数 ToolResultPart 出现次数，确定"哪些需要保留原样"的 callId 集合
  const recentCallIds = new Set<string>()
  for (let i = messages.length - 1; i >= 0 && recentCallIds.size < keepRecent; i--) {
    const content = messages[i].content as vscode.LanguageModelInputPart[]
    for (let j = content.length - 1; j >= 0 && recentCallIds.size < keepRecent; j--) {
      const part = content[j]
      if (part instanceof vscode.LanguageModelToolResultPart) {
        recentCallIds.add(part.callId)
      }
    }
  }

  // 第二遍：替换所有不在"近期保留集合"中的 ToolResultPart 文本
  let replacedCount = 0
  let savedChars = 0
  const result = messages.map((msg) => {
    const content = msg.content as vscode.LanguageModelInputPart[]
    let mutated = false

    const newContent = content.map((part) => {
      if (!(part instanceof vscode.LanguageModelToolResultPart)) return part
      if (recentCallIds.has(part.callId)) return part

      const totalText = sumToolResultTextLength(part)
      if (totalText < minChars) return part

      mutated = true
      replacedCount++
      savedChars += totalText - MICRO_COMPACT_TOOL_RESULT_STUB.length
      return new vscode.LanguageModelToolResultPart(part.callId, [
        new vscode.LanguageModelTextPart(MICRO_COMPACT_TOOL_RESULT_STUB),
      ])
    })

    return mutated ? cloneMessageWithContent(msg, newContent) : msg
  })

  if (replacedCount > 0) {
    log(`[Context] 微压缩：${replacedCount} 个旧工具结果，约节省 ${savedChars} 字符`)
  }
  return result
}

/** 累计单个 ToolResultPart 内所有 LanguageModelTextPart 的字符长度 */
function sumToolResultTextLength(part: vscode.LanguageModelToolResultPart): number {
  let total = 0
  for (const inner of part.content) {
    if (inner instanceof vscode.LanguageModelTextPart) {
      total += inner.value.length
    }
  }
  return total
}

/** 用新内容克隆一条 ChatMessage（保留 role；name 字段官方 API 不暴露读取，照搬 role 即可） */
function cloneMessageWithContent(
  original: vscode.LanguageModelChatMessage,
  newContent: vscode.LanguageModelInputPart[],
): vscode.LanguageModelChatMessage {
  if (original.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return vscode.LanguageModelChatMessage.Assistant(
      newContent as Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
    )
  }
  // 默认 User（VS Code LM API 仅有 User / Assistant 两种角色）
  return vscode.LanguageModelChatMessage.User(
    newContent as Array<
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolResultPart
      | vscode.LanguageModelDataPart
    >,
  )
}

/**
 * 在 LLM 摘要压缩前剥离图像 DataPart
 *
 * 摘要任务是纯文本归纳，图像送进去：
 *   1. 浪费上下文（vision 模型对图像有显著 token 成本）
 *   2. 大概率拖慢响应（多模态推理慢于纯文本）
 *   3. 文本-only 模型直接报错
 *
 * 图像条目替换为简短文本占位（保留"曾经有图像"的语义信号）。
 */
function stripImagesForCompact(
  messages: vscode.LanguageModelChatMessage[],
): vscode.LanguageModelChatMessage[] {
  if (!config.agent.stripImagesInCompact) return messages

  return messages.map((msg) => {
    const content = msg.content as vscode.LanguageModelInputPart[]
    let mutated = false

    const newContent: vscode.LanguageModelInputPart[] = []
    for (const part of content) {
      // 顶层 DataPart（罕见，但 API 允许）：直接替换为占位文本
      if (part instanceof vscode.LanguageModelDataPart) {
        mutated = true
        newContent.push(new vscode.LanguageModelTextPart('[image omitted for summary]'))
        continue
      }
      // ToolResultPart 内嵌的 DataPart：拆开重组，仅保留文本
      if (part instanceof vscode.LanguageModelToolResultPart) {
        let innerMutated = false
        // ToolResultPart.content 类型签名包含 unknown，这里手动收窄为可构造类型
        const filteredInner: unknown[] = []
        for (const inner of part.content) {
          if (inner instanceof vscode.LanguageModelDataPart) {
            innerMutated = true
            filteredInner.push(new vscode.LanguageModelTextPart('[image omitted for summary]'))
          } else {
            filteredInner.push(inner)
          }
        }
        if (innerMutated) {
          mutated = true
          newContent.push(new vscode.LanguageModelToolResultPart(part.callId, filteredInner))
        } else {
          newContent.push(part)
        }
        continue
      }
      newContent.push(part)
    }

    return mutated ? cloneMessageWithContent(msg, newContent) : msg
  })
}

/**
 * 构建工作区静态上下文（注入到 Prompt 层 3，作为 KV 缓存的稳定前缀锚点）
 * 只包含不随日期或 git 操作变化的字段：projectRoot、gitBranch、gitMainBranch
 */
function buildStableWorkspaceBlock(wsCtx: WorkspaceContext): string {
  return [
    `Current project: ${wsCtx.projectRoot}`,
    `Git branch: ${wsCtx.gitBranch} (main branch: ${wsCtx.gitMainBranch})`,
  ].join('\n')
}

/**
 * 构建工作区动态上下文（注入到每轮首个用户消息之前）
 * 包含随日期或 git 操作变化的字段：today、gitRecentCommits、gitStatus
 * 放在消息末尾以保护稳定前缀（层 1-3）的 KV 缓存命中率
 */
function buildDynamicContextBlock(wsCtx: WorkspaceContext): string {
  return [
    `Today: ${wsCtx.today}`,
    `Recent commits:\n${wsCtx.gitRecentCommits}`,
    `Git status:\n${wsCtx.gitStatus}`,
  ].join('\n')
}

/**
 * 构建历史消息列表（Prompt 层 4）
 *
 * 优先路径：消息数超过 compactThreshold 时，调 LLM 生成摘要替代旧历史
 * 降级路径：摘要失败时，截断至 maxHistoryTurns 条
 */
async function buildHistoryMessages(
  history: vscode.ChatContext,
): Promise<vscode.LanguageModelChatMessage[]> {
  const raw = convertChatHistoryToMessages(history)
  if (raw.length === 0) return []

  const { compactHistoryEnabled, compactThreshold, maxHistoryTurns } = config.agent

  // 消息数未超阈值，直接返回
  if (!compactHistoryEnabled || raw.length <= compactThreshold) {
    return raw.slice(-maxHistoryTurns)
  }

  // 超过阈值：尝试 LLM 摘要压缩
  log(`[Context] 历史消息数 ${raw.length} 超过阈值 ${compactThreshold}，尝试 LLM 摘要压缩`)
  try {
    return await compactHistoryWithLLM(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`[Context] 历史压缩失败，降级为截断：${msg}`)
    return raw.slice(-maxHistoryTurns)
  }
}

/**
 * 将 ChatContext.history 转换为 LanguageModelChatMessage 列表。
 * 只提取文本内容（跨 Turn 的工具历史在 VS Code API 层面不可访问）。
 */
function convertChatHistoryToMessages(
  history: vscode.ChatContext,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = []

  for (const turn of history.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt))
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter(
          (p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart,
        )
        .map((p) => p.value.value)
        .join('')
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text))
      }
    }
  }

  return messages
}

/**
 * 通过激活的 LLM Adapter 生成历史摘要，返回 [摘要 User 消息, Assistant 接续确认] 两条消息。
 */
async function compactHistoryWithLLM(
  messages: vscode.LanguageModelChatMessage[],
): Promise<vscode.LanguageModelChatMessage[]> {
  const adapter = getActiveAdapter()

  // 摘要任务对图像无意义且代价高，先剥离 DataPart 再送给 LLM
  const sanitized = stripImagesForCompact(messages)

  const compactRequest: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(COMPACT_SYSTEM_PROMPT),
    ...sanitized,
    vscode.LanguageModelChatMessage.User('Generate the summary in the format described above.'),
  ]

  const abortController = new AbortController()
  // 超时保护：压缩是辅助优化，不应阻塞 Agent 初始化
  const timeoutId = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT_MS)

  let summary = ''
  try {
    for await (const part of adapter.chat({
      messages: compactRequest,
      tools: [],
      signal: abortController.signal,
    })) {
      if (part instanceof vscode.LanguageModelTextPart) {
        summary += part.value
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`LLM 摘要调用失败：${msg}`)
  } finally {
    clearTimeout(timeoutId)
  }

  if (!summary.trim()) throw new Error('LLM 返回空摘要')

  log(`[Context] 历史压缩完成，摘要长度：${summary.length} 字符`)

  return [
    vscode.LanguageModelChatMessage.User(
      `[Conversation history summary — earlier turns were compacted due to context limits]\n\n${summary}`,
    ),
    vscode.LanguageModelChatMessage.Assistant(COMPACT_ACK),
  ]
}
