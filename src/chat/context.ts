import * as vscode from 'vscode'
import { config } from '../config'
import { selectModel, sendChatRequest } from '../llm/client'
import { buildSystemPrompt } from '../constants/prompts'
import { AVAILABLE_TOOLS } from '../tools/registry'
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

  /**
   * @param wsCtx    工作区上下文（git 信息等），注入到层 3
   * @param history  Copilot Chat 传入的对话历史（跨 Turn），注入到层 4
   */
  constructor(wsCtx: WorkspaceContext, history: vscode.ChatContext) {
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

    const systemParts = [buildSystemPrompt(AVAILABLE_TOOLS.map((t) => t.name))]
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

    // ── 层 3：工作区上下文 ───────────────────────────────────────────────────
    const contextBlock = buildWorkspaceContextBlock(wsCtx)
    this.messages.push(vscode.LanguageModelChatMessage.User(contextBlock))
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
   */
  async buildForFirstRound(userPrompt: string): Promise<vscode.LanguageModelChatMessage[]> {
    await this.ready
    return [...this.messages, vscode.LanguageModelChatMessage.User(userPrompt)]
  }

  /**
   * 获取当前消息列表（不追加用户输入）
   * 在 loop 第 2+ 轮调用（工具结果已在上一轮末尾追加）。
   */
  buildForContinuationRound(): vscode.LanguageModelChatMessage[] {
    return [...this.messages]
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

/** 构建工作区上下文文本块（注入到 Prompt 层 3） */
function buildWorkspaceContextBlock(wsCtx: WorkspaceContext): string {
  return [
    `Current project: ${wsCtx.projectRoot}`,
    `Today: ${wsCtx.today}`,
    `Git branch: ${wsCtx.gitBranch} (main branch: ${wsCtx.gitMainBranch})`,
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
 * 调用 LLM 生成历史摘要，返回 [摘要 User 消息, Assistant 接续确认] 两条消息。
 */
async function compactHistoryWithLLM(
  messages: vscode.LanguageModelChatMessage[],
): Promise<vscode.LanguageModelChatMessage[]> {
  const model = await selectModel()
  if (!model) throw new Error('未找到可用模型')

  const compactRequest: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(COMPACT_SYSTEM_PROMPT),
    ...messages,
    vscode.LanguageModelChatMessage.User('Generate the summary in the format described above.'),
  ]

  const tokenSource = new vscode.CancellationTokenSource()
  const response = await sendChatRequest(model, compactRequest, [], tokenSource.token)
  tokenSource.dispose()

  let summary = ''
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      summary += part.value
    }
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
