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
   */
  build(userPrompt: string): vscode.LanguageModelChatMessage[] {
    return [...this.messages, vscode.LanguageModelChatMessage.User(userPrompt)]
  }

  /**
   * 将本轮 Assistant 回复追加进历史，供下一轮使用
   */
  appendAssistant(text: string): void {
    this.messages.push(vscode.LanguageModelChatMessage.Assistant(text))
  }

  /**
   * 将工具执行结果作为用户观察追加进历史
   * 格式：[Observation] <内容>，让 LLM 感知到行动结果
   */
  appendObservation(observation: string): void {
    this.messages.push(vscode.LanguageModelChatMessage.User(`[Observation]\n${observation}`))
  }
}
