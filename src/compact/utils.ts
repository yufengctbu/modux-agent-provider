import * as vscode from 'vscode'

// ─────────────────────────────────────────────────────────────────────────────
// 上下文压缩模块 — 内部共享工具函数
//
// 这些函数被多个 compact 子模块复用，独立出来避免重复代码。
// 仅在 compact/ 目录内使用，不对外导出。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 克隆消息并替换其内容数组，保留原消息的 role。
 *
 * VS Code LM API 的消息对象是只读的，无法直接修改 content，
 * 必须用工厂方法重建。此函数封装了 User/Assistant 两种 role 的重建逻辑。
 *
 * @param original  原始消息（仅读取 role）
 * @param newContent 替换后的内容数组
 */
export function cloneMessageWithContent(
  original: vscode.LanguageModelChatMessage,
  newContent: vscode.LanguageModelInputPart[],
): vscode.LanguageModelChatMessage {
  if (original.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return vscode.LanguageModelChatMessage.Assistant(
      newContent as Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
    )
  }
  // User role（含 ToolResultPart / DataPart）
  return vscode.LanguageModelChatMessage.User(
    newContent as Array<
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolResultPart
      | vscode.LanguageModelDataPart
    >,
  )
}

/**
 * 累计 ToolResultPart 内所有 TextPart 的字符总长度。
 *
 * 用于判断是否值得对该工具结果做微压缩（低于阈值则不压缩）。
 * DataPart（图像）不计入，因为它们有独立的处理路径。
 */
export function sumToolResultTextLength(part: vscode.LanguageModelToolResultPart): number {
  let total = 0
  for (const inner of part.content) {
    if (inner instanceof vscode.LanguageModelTextPart) {
      total += inner.value.length
    }
  }
  return total
}

/**
 * 判断一个错误是否为"上下文过长"类错误。
 *
 * 不同后端的错误格式不一，这里做通用关键词匹配兜底。
 * 注意：故意保守匹配，避免把正常的业务错误当作 context 过长处理。
 *
 * @param err  任意 catch 到的值
 */
export function isContextTooLongError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  // OpenAI / DeepSeek 标准错误码
  if (msg.includes('context_length_exceeded')) return true
  // 通用描述
  if (msg.includes('maximum context length')) return true
  if (msg.includes('too many tokens')) return true
  // HTTP 400 + token 关键词（宽松兜底）
  const status = (err as { status?: number }).status
  if (status === 400 && msg.includes('token') && msg.includes('exceed')) return true
  return false
}
