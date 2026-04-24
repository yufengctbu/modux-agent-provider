import * as vscode from 'vscode'
import { getWorkspaceContext } from './workspace'
import { runAgentLoop } from './loop'
import { log } from '../shared/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Chat 层入口
//
// 职责：
//   1. 解析 VS Code 原始请求类型
//   2. 采集工作区上下文（首次调用有 I/O，后续走模块级缓存）
//   3. 启动 Agent Loop
//
// 边界：此模块不包含业务逻辑，业务逻辑在 loop.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VS Code Chat 请求处理入口
 *
 * 在启动 Agent Loop 前采集工作区上下文（git 信息等），
 * 确保 loop 中的 ContextBuilder 可以构建完整的 4 层 Prompt。
 */
export async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  log(`[Handler] 收到消息：${request.prompt}`)

  // 采集工作区上下文（首次调用约 100ms，后续走缓存，几乎零开销）
  const wsCtx = await getWorkspaceContext()

  await runAgentLoop(request.prompt, context, stream, token, wsCtx)

  log('[Handler] 请求处理完成')
}
