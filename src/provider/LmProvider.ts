import * as vscode from 'vscode'
import { log } from '../shared/logger'
import { getActiveAdapter } from './registry'
import { estimateMessageTokens } from '../shared/tokenEstimator'

// ─────────────────────────────────────────────────────────────────────────────
// modux-agent Language Model Provider（薄壳实现）
//
// 实现 vscode.LanguageModelChatProvider 接口，使 modux-agent 出现在
// Copilot Chat 的模型下拉列表中。
//
// 职责边界：
//   - 仅负责把 VS Code LM API 的调用转接给 registry 中激活的 Adapter
//   - 不含任何"与具体 LLM 通信"的逻辑（这些全部由 adapters/ 下的实现提供）
//
// 取消传播：token.onCancellationRequested → AbortController.abort()，
// 由 Adapter 内部再桥接到各自底层的取消机制。
// ─────────────────────────────────────────────────────────────────────────────

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
   * 处理聊天请求：委托给激活的 Adapter，把其流式 Part 转发给 VS Code
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
      log(`[LM Provider] 未找到可用 Adapter：${msg}`)
      progress.report(new vscode.LanguageModelTextPart(`**配置错误**：${msg}`))
      return
    }

    log(
      `[LM Provider] 请求：model=${model.id}，messages=${messages.length}，adapter=${adapter.type}`,
    )

    const abortController = new AbortController()
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort())

    try {
      for await (const part of adapter.chat({
        messages: messages as unknown as readonly vscode.LanguageModelChatMessage[],
        tools: options.tools ?? [],
        signal: abortController.signal,
        toolMode: options.toolMode,
      })) {
        progress.report(part)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      const msg = err instanceof Error ? err.message : String(err)
      log(`[LM Provider] Adapter 执行失败：${msg}`)
      progress.report(new vscode.LanguageModelTextPart(`**请求失败**：${msg}`))
    } finally {
      cancelDisposable.dispose()
    }
  }

  /**
   * 估算 token 数，供 VS Code 渲染圆形 token 进度条
   *
   * 按输入类型分流：
   *   - string → 委托给适配器的 countTokens（内部使用字符分类估算）
   *   - Message → 使用 estimateMessageTokens 按 Part 类型分别估算
   *
   * 兜底：getActiveAdapter() 失败时返回 0，保证进度条不崩溃。
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // Message 类型：按 Part 分类估算，避免 JSON.stringify 计入结构开销
    if (typeof text !== 'string') {
      return estimateMessageTokens(text)
    }

    // 纯文本：委托给适配器
    let adapter
    try {
      adapter = getActiveAdapter()
    } catch {
      return 0
    }

    return adapter.countTokens(text)
  }
}
