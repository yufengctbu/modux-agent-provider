import * as path from 'node:path'
import * as vscode from 'vscode'
import { getWorkspaceContext } from './workspace'
import { runAgentLoop } from './loop'
import { getAdapterByType } from '../provider/registry'
import { log } from '../shared/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Chat 层入口
//
// 职责：
//   1. 解析 VS Code 原始请求类型
//   2. 序列化 request.references（#file: / #selection 等用户附加上下文）
//   3. 采集工作区上下文（首次调用有 I/O，后续走模块级缓存）
//   4. 启动 Agent Loop
//
// 边界：此模块不包含业务逻辑，业务逻辑在 loop.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将 VS Code Chat 的 references 数组序列化为文本块，直接注入首轮 Prompt。
 *
 * 用户通过 #file: / #selection / #codebase 等语法附加的上下文，
 * value 可能是 vscode.Uri（文件）、vscode.Location（文件片段）或 string（纯文本）。
 * 将其内联到 prompt 中，LLM 无需额外工具调用即可使用这些内容。
 *
 * 安全：文件内容来自本地工作区，不存在外部注入风险；
 *        内容超大时截断至 maxChars 并附提示，避免撑爆上下文。
 */
async function serializeReferences(
  refs: readonly vscode.ChatPromptReference[],
  maxCharsPerRef = 20_000,
): Promise<string> {
  if (refs.length === 0) return ''

  const blocks: string[] = []

  for (const ref of refs) {
    try {
      if (ref.value instanceof vscode.Uri) {
        // #file: 引用 → 读取文件全文
        const uri = ref.value
        // ref.id 是类型标识符（如 'vscode.file'），不是文件名；始终用 basename
        const label = path.basename(uri.fsPath)
        const raw = await vscode.workspace.fs.readFile(uri)
        let text = Buffer.from(raw).toString('utf-8')
        const truncated = text.length > maxCharsPerRef
        if (truncated) {
          text = text.slice(0, maxCharsPerRef)
        }
        blocks.push(
          `<file name="${label}" path="${uri.fsPath}">\n${text}${truncated ? '\n...[truncated]' : ''}\n</file>`,
        )
      } else if (ref.value instanceof vscode.Location) {
        // #selection 或带行范围的文件引用 → 读取指定片段
        const loc = ref.value
        const label = path.basename(loc.uri.fsPath)
        const raw = await vscode.workspace.fs.readFile(loc.uri)
        const allLines = Buffer.from(raw).toString('utf-8').split('\n')
        const startLine = loc.range.start.line
        const endLine = loc.range.end.line
        const snippet = allLines.slice(startLine, endLine + 1).join('\n')
        blocks.push(
          `<file name="${label}" path="${loc.uri.fsPath}" lines="${startLine + 1}-${endLine + 1}">\n${snippet}\n</file>`,
        )
      } else if (typeof ref.value === 'string') {
        // 纯文本引用（如 #codebase 摘要）：ref.id 在此处是有意义的类型标识（如 'vscode.codebase'）
        const label = ref.id
        blocks.push(`<reference name="${label}">\n${ref.value}\n</reference>`)
      }
    } catch (err) {
      // 单个引用读取失败不中断整体流程，记录日志并跳过
      const msg = err instanceof Error ? err.message : String(err)
      log(`[Handler] references 序列化失败（${ref.id ?? 'unknown'}）：${msg}`)
    }
  }

  if (blocks.length === 0) return ''
  return `## Attached Context\n\n${blocks.join('\n\n')}`
}

/**
 * VS Code Chat 请求处理入口
 *
 * 在启动 Agent Loop 前：
 *   1. 序列化 request.references，内联到首轮 prompt（LLM 可直接使用，无需工具调用）
 *   2. 采集工作区上下文（git 信息等）
 */
export async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  log(`[Handler] 收到消息：${request.prompt}`)

  // 并发：references 序列化与工作区上下文采集互相独立，可同时进行
  const [referencesText, wsCtx] = await Promise.all([
    serializeReferences(request.references),
    getWorkspaceContext(),
  ])

  // 将引用内容前置于用户 prompt，形成完整首轮输入
  const fullPrompt = referencesText ? `${referencesText}\n\n${request.prompt}` : request.prompt

  if (referencesText) {
    log(`[Handler] 注入 ${request.references.length} 个 references`)
  }

  await runAgentLoop(fullPrompt, context, stream, token, wsCtx)

  log('[Handler] 请求处理完成')
}

/**
 * DeepSeek Chat Participant 请求处理入口
 *
 * 与 handleChatRequest 相同流程，但强制使用 DeepSeek 适配器，
 * 与 config.llms 中的 enabled 标志无关。
 */
export async function handleDeepSeekChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  log(`[Handler] DeepSeek 收到消息：${request.prompt}`)

  let adapter
  try {
    adapter = getAdapterByType('deepseek')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`[Handler] DeepSeek Adapter 未就绪：${msg}`)
    stream.markdown(`**配置错误**：${msg}`)
    return
  }

  // 并发：references 序列化与工作区上下文采集互相独立，可同时进行
  const [referencesText, wsCtx] = await Promise.all([
    serializeReferences(request.references),
    getWorkspaceContext(),
  ])

  const fullPrompt = referencesText ? `${referencesText}\n\n${request.prompt}` : request.prompt

  if (referencesText) {
    log(`[Handler] DeepSeek 注入 ${request.references.length} 个 references`)
  }

  await runAgentLoop(fullPrompt, context, stream, token, wsCtx, adapter)

  log('[Handler] DeepSeek 请求处理完成')
}
