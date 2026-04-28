import type * as vscode from 'vscode'

export type TokenCountOptions = { jsonMode?: boolean }

export interface TokenCounter {
  readonly type: string
  readonly available: boolean
  countText(text: string, options?: TokenCountOptions): number
}

export interface TokenManagerLike {
  countText(llmType: string | undefined, text: string, options?: TokenCountOptions): number
  countMessage(llmType: string | undefined, msg: vscode.LanguageModelChatRequestMessage): number
  countMessages(
    llmType: string | undefined,
    messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
  ): number
}
