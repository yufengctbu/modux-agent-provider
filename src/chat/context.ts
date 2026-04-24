import * as vscode from 'vscode'

/**
 * 负责构建和维护每一轮 LLM 调用所需的消息列表
 *
 * 持有对话历史，每轮循环结束后追加 assistant 回复，
 * 确保下一轮 LLM 调用能看到完整上下文。
 */
export class ContextBuilder {
  private readonly messages: vscode.LanguageModelChatMessage[] = []

  constructor(
    /** Copilot Chat 传入的对话历史，包含本轮之前的所有轮次 */
    history: vscode.ChatContext,
    /** 可选的 system prompt，用于约束 Agent 行为 */
    systemPrompt?: string,
  ) {
    // 注入 system prompt（通过 User 角色模拟，vscode LM API 不支持 System 角色）
    if (systemPrompt) {
      this.messages.push(vscode.LanguageModelChatMessage.User(systemPrompt))
      this.messages.push(
        vscode.LanguageModelChatMessage.Assistant('Understood. I will follow these instructions.'),
      )
    }

    // 追加历史对话轮次（最近 10 条，避免超出 token 上限）
    const recentHistory = history.history.slice(-10)
    for (const turn of recentHistory) {
      if (turn instanceof vscode.ChatRequestTurn) {
        this.messages.push(vscode.LanguageModelChatMessage.User(turn.prompt))
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter(
            (p): p is vscode.ChatResponseMarkdownPart =>
              p instanceof vscode.ChatResponseMarkdownPart,
          )
          .map((p) => p.value.value)
          .join('')
        if (text) {
          this.messages.push(vscode.LanguageModelChatMessage.Assistant(text))
        }
      }
    }
  }

  /**
   * 构建本轮完整消息列表（历史 + 当前用户输入）
   * 用于 Loop 第 1 轮：在已有历史末尾追加本次用户输入
   */
  build(userPrompt: string): vscode.LanguageModelChatMessage[] {
    return [...this.messages, vscode.LanguageModelChatMessage.User(userPrompt)]
  }

  /**
   * 获取当前消息列表（不追加用户输入）
   * 用于 Loop 第 2+ 轮（工具调用轮次）：历史中已包含工具结果，无需重复追加用户 prompt
   */
  buildForContinuation(): vscode.LanguageModelChatMessage[] {
    return [...this.messages]
  }

  /**
   * 追加包含工具调用的 Assistant 消息
   *
   * 将本轮 LLM 输出的文本段和工具调用段一起写入上下文，
   * 确保下一轮 LLM 能感知到「自己说了什么、调用了什么工具」。
   */
  appendAssistantWithToolCalls(
    textParts: vscode.LanguageModelTextPart[],
    toolCalls: vscode.LanguageModelToolCallPart[],
  ): void {
    this.messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]))
  }

  /**
   * 追加工具执行结果（作为 User 角色的 ToolResultPart）
   *
   * VS Code LM API 规定工具结果以 User 消息的形式回传，
   * 每个 ToolResultPart 通过 callId 与对应的 ToolCallPart 关联。
   */
  appendToolResults(results: vscode.LanguageModelToolResultPart[]): void {
    this.messages.push(vscode.LanguageModelChatMessage.User(results))
  }

  /**
   * 将工具执行结果作为用户观察追加进历史（纯文本格式）
   * 适用于不支持结构化 ToolResultPart 的场景
   */
  appendObservation(observation: string): void {
    this.messages.push(vscode.LanguageModelChatMessage.User(`[Observation]\n${observation}`))
  }
}
