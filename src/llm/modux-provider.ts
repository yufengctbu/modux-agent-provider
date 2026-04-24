import * as vscode from 'vscode'
import { log } from '../shared/logger'

/** 读取后端配置 */
function getBackendConfig(): { enabled: boolean; url: string } {
  const cfg = vscode.workspace.getConfiguration('modux-agent.backend')
  return {
    enabled: cfg.get<boolean>('enabled', false),
    url: cfg.get<string>('url', 'http://localhost:3000/v1/chat'),
  }
}

/**
 * modux-agent 模型的元数据
 * 用于在 Copilot Chat 模型下拉列表中展示
 */
const MODEL_INFO: vscode.LanguageModelChatInformation = {
  id: 'modux-agent',
  name: 'modux-agent',
  family: 'modux-agent',
  version: '1.0.0',
  tooltip: 'Modux Agent — 你的智能编码助手',
  maxInputTokens: 128000,
  maxOutputTokens: 16384,
  capabilities: {
    // 声明支持工具调用，与 chat/tools/registry.ts 的 AVAILABLE_TOOLS 联动
    toolCalling: true,
  },
}

/**
 * modux-agent Language Model Provider
 *
 * 实现 vscode.LanguageModelChatProvider 接口后，modux-agent 会出现在
 * Copilot Chat 的模型下拉列表中。用户选中它发送消息时，VS Code 直接
 * 调用 provideLanguageModelChatResponse，messages 包含完整对话上下文。
 *
 * 当前实现：将消息透传给底层 Copilot gpt-4o 并流式返回结果。
 *
 * 扩展点：在 provideLanguageModelChatResponse 中可插入任意自定义逻辑：
 * - 注入 system prompt（角色/约束/知识）
 * - RAG 检索后追加上下文
 * - 对底层模型响应做后处理再输出
 */
export class ModuxModelProvider implements vscode.LanguageModelChatProvider {
  /**
   * 返回本 provider 提供的模型列表
   * VS Code 调用此方法以获知有哪些可用模型，并将其显示在下拉列表中
   */
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return [MODEL_INFO]
  }

  /**
   * 处理来自 VS Code 的聊天请求
   *
   * @param model    - 用户选中的模型信息（本 provider 提供的 MODEL_INFO）
   * @param messages - 完整对话上下文，包含历史轮次 + 当前用户输入
   * @param options  - 请求选项，含工具列表、toolMode 等
   * @param progress - 流式输出通道，通过 progress.report(part) 逐步返回内容
   * @param token    - 取消令牌
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { enabled, url } = getBackendConfig()
    log(`[LM Provider] 收到请求，模型=${model.id}，消息数=${messages.length}，后端转发=${enabled}`)

    if (!enabled) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '（modux-agent 后端转发未启用，请在设置中开启 `modux-agent.backend.enabled`）',
        ),
      )
      return
    }

    log(`[LM Provider] 转发至后端：${url}`)

    // 将消息序列化为后端可接收的格式
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

      // 支持 SSE 流式（text/event-stream）和普通 JSON 两种响应格式
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        while (!token.isCancellationRequested) {
          const { done, value } = await reader.read()
          if (done) break
          const lines = decoder.decode(value).split('\n')
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') break
            try {
              const chunk = JSON.parse(data) as { content?: string }
              if (chunk.content) progress.report(new vscode.LanguageModelTextPart(chunk.content))
            } catch {
              // 忽略非 JSON 行
            }
          }
        }
      } else {
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
   * 估算消息或文本的 token 数量
   * 粗略公式：4 个字符 ≈ 1 个 token（英文约准，中文偏低估）
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
