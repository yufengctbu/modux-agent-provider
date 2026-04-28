import * as vscode from 'vscode'
import { getActiveAdapter } from './registry'
import { getTokenManager } from '../token'
import { getWorkspaceContext, loadMemoryFile } from '../chat/workspace'
import { buildSystemPrompt } from '../constants/prompts'
import { config } from '../config'
import { CompactManager } from '../compact'

// ─────────────────────────────────────────────────────────────────────────────
// modux-agent Language Model Provider
//
// 实现 vscode.LanguageModelChatProvider 接口，使 modux-agent 出现在
// Copilot Chat 的模型下拉列表中。
//
// 职责边界：
//   - 拦截 VS Code 传入的消息列表，替换 Copilot 默认 system prompt 为我们自己的
//   - 注入工作区上下文（git 分支、状态、项目路径）和 Memory 文件
//   - 对历史消息执行上下文压缩（微压缩 + 自动压缩 + 响应式压缩）
//   - 将重建后的消息 + 系统工具（options.tools）转发给 registry 中激活的 Adapter
//
// 消息重建策略：
//   messages[0] = Copilot 注入的 system 消息（role=3），直接跳过
//   messages[1..] = 历史对话 + 当前用户消息，完整保留
//   重建结果 = [我们的 system prompt, ACK, 工作区上下文, ACK, ...messages[1..]]
//   PREFIX_COUNT = 4（前四条是固定前缀，不参与压缩）
//
// Loop 说明：
//   LM Provider 模式下 VS Code 是 agent loop 控制器。
//   我们的职责是：每次被调用时对消息做压缩，再转发给后端 Adapter。
//   压缩发生在向后端发送之前，对 VS Code 透明。
//
// 取消传播：token.onCancellationRequested → AbortController.abort()
// ─────────────────────────────────────────────────────────────────────────────

/** 固定前缀消息数（system prompt + ACK + 工作区上下文 + ACK），不参与压缩 */
const PREFIX_COUNT = 4
const tokenManager = getTokenManager()

export class LmProvider implements vscode.LanguageModelChatProvider {
  /**
   * 返回本 provider 提供的模型元数据
   * 具体内容由激活的 Adapter 决定
   */
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return getActiveAdapter().getChatInformation()
  }

  /**
   * 处理聊天请求
   *
   * 重建消息列表：跳过 Copilot 的 system 消息（messages[0]），
   * 注入我们自己的 system prompt + 工作区上下文，压缩历史消息，再转发给 Adapter。
   * 工具列表直接使用 options.tools（VS Code 系统内置工具）。
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let adapter
    try {
      adapter = getActiveAdapter()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      progress.report(new vscode.LanguageModelTextPart(`**配置错误**：${msg}`))
      return
    }

    // ── 采集工作区上下文 & 构建我们自己的 system prompt ──────────────────────
    const wsCtx = await getWorkspaceContext()
    const toolNames = (options.tools ?? []).map((t) => t.name)
    const memoryContent = await loadMemoryFile(wsCtx.projectRoot)
    const userSystemPrompt = config.agent.systemPrompt?.trim()
    const language = config.agent.language?.trim()

    const systemParts = [buildSystemPrompt(toolNames)]
    if (userSystemPrompt) systemParts.push(`\n\n## User Custom Instructions\n${userSystemPrompt}`)
    if (memoryContent) systemParts.push(`\n\n## Project Instructions (Memory)\n${memoryContent}`)
    if (language) {
      systemParts.push(
        `\n\n# Language\nAlways respond in ${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms, code identifiers, and file paths should remain in their original form.\nYour internal reasoning and thinking process must always be in English, regardless of the response language.`,
      )
    }

    // ── 工作区上下文块 ────────────────────────────────────────────────────────
    const wsBlock = [
      `Current project: ${wsCtx.projectRoot}`,
      `Git branch: ${wsCtx.gitBranch} (main branch: ${wsCtx.gitMainBranch})`,
      `Today: ${wsCtx.today}`,
      `Git status:\n${wsCtx.gitStatus}`,
      `Recent commits:\n${wsCtx.gitRecentCommits}`,
    ].join('\n')

    // ── 重建消息列表 ──────────────────────────────────────────────────────────
    // messages[0] = Copilot 注入的 system 消息（role=3），跳过
    // messages[1..] = 对话历史 + 当前用户消息，完整保留
    const conversationMessages = messages.slice(1) as unknown as vscode.LanguageModelChatMessage[]

    // 4 条固定前缀 + 对话历史（可被压缩）
    let rebuiltMessages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemParts.join('')),
      vscode.LanguageModelChatMessage.Assistant('Understood. I will follow these instructions.'),
      vscode.LanguageModelChatMessage.User(wsBlock),
      vscode.LanguageModelChatMessage.Assistant(
        'Understood. I have the current workspace context.',
      ),
      ...conversationMessages,
    ]

    // ── 上下文压缩（Layer 3 自动压缩） ───────────────────────────────────────
    // CompactContextBuilder 的最小接口实现，让 CompactManager 可以读写历史部分
    const compactCtx = {
      prefixCount: PREFIX_COUNT,
      getHistoryMessages: () => rebuiltMessages.slice(PREFIX_COUNT),
      replaceHistoryMessages: (msgs: vscode.LanguageModelChatMessage[]) => {
        rebuiltMessages = [...rebuiltMessages.slice(0, PREFIX_COUNT), ...msgs]
      },
    }
    const compactMgr = new CompactManager(adapter, compactCtx)

    // 把工具定义的 token 开销纳入压缩预算：
    // options.tools（60+ 个工具定义）约 25K token，独立于 messages 传给后端，
    // CompactManager 估算消息 token 时看不到这部分，必须显式补偿，
    // 否则阈值触发过晚，实际发给后端时 messages + tools 已超出上下文窗口。
    const toolsExtraTokens = (options.tools ?? []).reduce((sum, t) => {
      return (
        sum +
        tokenManager.countText(
          adapter.type,
          (t.description ?? '') + JSON.stringify(t.inputSchema ?? {}),
          {
            jsonMode: true,
          },
        )
      )
    }, 0)
    rebuiltMessages = await compactMgr.applyAutoCompact(rebuiltMessages, toolsExtraTokens, () => {
      progress.report(new vscode.LanguageModelTextPart('\n\n> 正在压缩对话...\n\n'))
    })

    // ── 发送给 Adapter（响应式压缩包裹：context_too_long 时自动重试）─────────
    const abortController = new AbortController()
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort())

    const chatFn = (msgs: readonly vscode.LanguageModelChatMessage[]) =>
      adapter.chat({
        messages: msgs,
        tools: options.tools ?? [],
        signal: abortController.signal,
        toolMode: options.toolMode,
      })

    try {
      for await (const part of compactMgr.wrapChat(chatFn, rebuiltMessages)) {
        progress.report(part)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      progress.report(new vscode.LanguageModelTextPart(`**请求失败**：${msg}`))
    } finally {
      cancelDisposable.dispose()
    }
  }

  /**
   * 估算 token 数，供 VS Code 渲染圆形 token 进度条
   *
   * 按输入类型分流：
   *   - string → 委托给适配器的 countTokens（内部走 tokenManager）
   *   - Message → tokenManager 按当前 adapter.type 分发到对应计数器
   *
   * 兜底：getActiveAdapter() 失败时返回 0，保证进度条不崩溃。
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    let adapter
    try {
      adapter = getActiveAdapter()
    } catch {
      return 0
    }

    // Message 类型：按当前适配器类型分发到 tokenManager
    if (typeof text !== 'string') {
      let tokens = tokenManager.countMessage(adapter.type, text)

      // UI 进度条补偿：VS Code 无法感知我们注入的固定前缀+工具定义开销。
      // messages[0] 在运行时是 Copilot 注入的 system 消息（role=3），
      // 将补偿值展到该条上，使进度条分子更接近实际发给后端的 token 总量。
      const overhead = adapter.uiFixedOverheadTokens ?? 0
      if (overhead > 0 && (text.role as unknown as number) === 3) {
        tokens += overhead
      }

      return tokens
    }

    return adapter.countTokens(text)
  }
}
