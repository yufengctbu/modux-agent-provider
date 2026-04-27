import * as vscode from 'vscode'
import { config } from '../config'
import { buildSystemPrompt } from '../constants/prompts'
import { toolsManager } from '../tools'
import { log } from '../shared/logger'
import { loadMemoryFile, type WorkspaceContext } from './workspace'
import { applyMicrocompaction, initCompactHistory } from '../compact'

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

/** 固定前缀消息数量（层 1-4 各占 1 条：System Prompt + ACK + 工作区 + 工作区 ACK） */
export const CONTEXT_FIXED_PREFIX_COUNT = 4

// ── ContextBuilder ────────────────────────────────────────────────────────────

export class ContextBuilder {
  /**
   * 固定前缀消息数量，供 CompactManager 识别历史区间边界。
   * 值与模块常量 CONTEXT_FIXED_PREFIX_COUNT 始终保持一致。
   */
  readonly prefixCount = CONTEXT_FIXED_PREFIX_COUNT
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
   * @param wsCtx     工作区上下文（git 信息等），稳定部分注入层 3，动态部分注入每轮首个用户消息前
   * @param history   Copilot Chat 传入的对话历史（跨 Turn），注入到层 4
   * @param toolNames 向 LLM 声明的工具名列表，用于构建 System Prompt 的 Tool usage 节。
   *                  由 loop.ts 在工具过滤（routing.toolWhitelist）后传入，确保
   *                  System Prompt 与实际注入工具列表一致，避免"描述了但调不到"的混淆。
   */
  constructor(wsCtx: WorkspaceContext, history: vscode.ChatContext, toolNames: string[]) {
    this.wsCtx = wsCtx
    this.ready = this.initializeAsync(wsCtx, history, toolNames)
  }

  /**
   * 异步初始化（加载 Memory 文件 + 构建 4 层 Prompt）
   */
  private async initializeAsync(
    wsCtx: WorkspaceContext,
    history: vscode.ChatContext,
    toolNames: string[],
  ): Promise<void> {
    // ── 层 1：System Prompt（用 User 角色模拟） ──────────────────────────────
    const memoryContent = await loadMemoryFile(wsCtx.projectRoot)
    const userSystemPrompt = config.agent.systemPrompt?.trim()

    const systemParts = [buildSystemPrompt(toolNames)]
    if (userSystemPrompt) systemParts.push(`\n\n## User Custom Instructions\n${userSystemPrompt}`)
    if (memoryContent) systemParts.push(`\n\n## Project Instructions (Memory)\n${memoryContent}`)
    const language = config.agent.language?.trim()
    if (language)
      systemParts.push(
        `\n\n# Language\nAlways respond in ${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms, code identifiers, and file paths should remain in their original form.\nYour internal reasoning and thinking process must always be in English, regardless of the response language.`,
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

    return this.applyMicrocompaction()
  }

  /**
   * 获取当前消息列表（不追加用户输入）
   * 在 loop 第 2+ 轮调用（工具结果已在上一轮末尾追加）。
   */
  buildForContinuationRound(): vscode.LanguageModelChatMessage[] {
    return this.applyMicrocompaction()
  }

  // ── 历史消息访问（供 compact 模块使用） ──────────────────────────────────────

  /**
   * 返回固定前缀之后的全部历史消息（不含前缀）。
   *
   * 固定前缀 = CONTEXT_FIXED_PREFIX_COUNT 条（System Prompt + ACK + 工作区 + 工作区 ACK）。
   * 调用时机：autoCompact / reactiveCompact 需要拿到可压缩的历史区间。
   */
  getHistoryMessages(): vscode.LanguageModelChatMessage[] {
    return this.messages.slice(CONTEXT_FIXED_PREFIX_COUNT)
  }

  /**
   * 替换固定前缀之后的全部历史消息。
   *
   * 固定前缀永远不被修改，保证 System Prompt 等稳定结构不被压缩操作破坏。
   * 调用时机：autoCompact / reactiveCompact 完成摘要后回写新历史。
   */
  replaceHistoryMessages(msgs: vscode.LanguageModelChatMessage[]): void {
    this.messages.splice(
      CONTEXT_FIXED_PREFIX_COUNT,
      this.messages.length - CONTEXT_FIXED_PREFIX_COUNT,
      ...msgs,
    )
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

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  /**
   * 对 this.messages 执行微压缩并返回新数组。
   *
   * 包装 applyMicrocompactionWithStats，并在有替换时记录日志。
   * 每轮调用（含首轮无 ToolResult 的情况），保持逻辑一致。
   */
  private applyMicrocompaction(): vscode.LanguageModelChatMessage[] {
    const { messages, replacedCount, savedChars } = applyMicrocompaction(
      this.messages,
      {
        keepRecent: config.agent.microcompactKeepRecentToolResults ?? 6,
        minChars: config.agent.microcompactMinToolResultChars ?? 400,
      },
      config.agent.microcompactEnabled,
    )
    if (replacedCount > 0) {
      log(`[Context] 微压缩：${replacedCount} 个旧工具结果，约节省 ${savedChars} 字符`)
    }
    return messages
  }
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

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

  // 超过阈值：尝试 LLM 摘要压缩（内部自动读取 config.compact + 获取压缩 Adapter）
  log(`[Context] 历史消息数 ${raw.length} 超过阈值 ${compactThreshold}，尝试 LLM 摘要压缩`)

  return initCompactHistory(raw, maxHistoryTurns)
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
