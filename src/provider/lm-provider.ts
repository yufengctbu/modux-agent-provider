import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'

/**
 * modux-agent Language Model Provider
 *
 * 实现 vscode.LanguageModelChatProvider 接口，使 modux-agent 出现在
 * Copilot Chat 的模型下拉列表中。
 *
 * 用户选中后发送消息时，VS Code 调用 provideLanguageModelChatResponse，
 * 并传入完整对话上下文（messages 包含历史轮次 + 当前用户输入）。
 *
 * 当前行为由 src/config/config.json 中的 backend.enabled 控制：
 *   false → 返回占位提示，不发起任何网络请求
 *   true  → 将消息 POST 到 backend.url，支持 SSE 流式和普通 JSON 两种响应格式
 */
export class ModuxModelProvider implements vscode.LanguageModelChatProvider {
  /**
   * 返回本 provider 提供的模型元数据列表
   * VS Code 据此在模型选择器中展示 "Modux Agent"
   */
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return [
      {
        id: 'modux-agent',
        name: 'modux-agent',
        family: 'modux-agent',
        version: '1.0.0',
        tooltip: 'Modux Agent — 你的智能编码助手',
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        capabilities: { toolCalling: true },
      },
    ]
  }

  /**
   * 处理聊天请求
   *
   * @param model    用户选中的模型信息
   * @param messages 完整对话上下文（历史 + 当前输入）
   * @param options  请求选项（工具列表、toolMode 等）
   * @param progress 流式输出通道，通过 progress.report(part) 逐步返回内容
   * @param token    取消令牌
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { enabled, url } = config.backend
    log(`[LM Provider] 收到请求，模型=${model.id}，消息数=${messages.length}，后端转发=${enabled}`)

    // 后端转发未启用时直接返回提示
    if (!enabled) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '（modux-agent 后端转发未启用，请将 src/config/config.json 中的 backend.enabled 设为 true 后重新构建）',
        ),
      )
      return
    }

    log(`[LM Provider] 转发至后端：${url}`)

    // 将消息序列化为后端约定的格式：{ messages: [{role, content}] }
    const body = JSON.stringify({
      messages: messages.map((m) => ({
        role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
        content: m.content
          .filter(
            (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
          )
          .map((p) => p.value)
          .join(''),
      })),
    })

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: token.isCancellationRequested ? AbortSignal.abort() : undefined,
      })

      if (!res.ok) {
        const text = await res.text()
        log(`[LM Provider] 后端错误 HTTP ${res.status}：${text}`)
        progress.report(
          new vscode.LanguageModelTextPart(`**后端错误** HTTP ${res.status}：${text}`),
        )
        return
      }

      const contentType = res.headers.get('content-type') ?? ''

      if (contentType.includes('text/event-stream')) {
        // SSE 流式响应：逐行解析 "data: {...}" 并实时上报
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        while (!token.isCancellationRequested) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of decoder.decode(value).split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            try {
              const chunk = JSON.parse(data) as { content?: string }
              if (chunk.content) progress.report(new vscode.LanguageModelTextPart(chunk.content))
            } catch {
              // 忽略非 JSON 行（如空行、注释行）
            }
          }
        }
      } else {
        // 普通 JSON 响应：读取 content 或 message 字段
        const json = (await res.json()) as { content?: string; message?: string }
        const text = json.content ?? json.message ?? JSON.stringify(json)
        progress.report(new vscode.LanguageModelTextPart(text))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`[LM Provider] 请求失败：${msg}`)
      progress.report(new vscode.LanguageModelTextPart(`**请求失败**：${msg}`))
    }
  }

  /**
   * 估算 token 数量（粗略公式：4 字符 ≈ 1 token）
   * 用于 VS Code 在发送前做 token 预算检查
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const str = typeof text === 'string' ? text : JSON.stringify(text)
    return Math.ceil(str.length / 4)
  }
}
