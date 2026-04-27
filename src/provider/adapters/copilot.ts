import * as vscode from 'vscode'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'
import { estimateTokenCount } from '../../shared/tokenEstimator'

// ─────────────────────────────────────────────────────────────────────────────
// Copilot 适配器
//
// 通过 VS Code Language Model API 调用 Copilot 提供的底层模型（gpt-4o 等）。
// 迁移自原 src/llm/client.ts，在保留 selectChatModels + sendRequest 行为的
// 基础上，把接口适配到统一的 LlmAdapter。
//
// 取消机制：Adapter 对外接受 AbortSignal，内部桥接到 VS Code 的
// CancellationTokenSource —— 当 signal 触发 abort 时调 ts.cancel()。
// ─────────────────────────────────────────────────────────────────────────────

/** Copilot 适配器配置结构（来自 config.llms 中 type=copilot 的条目） */
interface CopilotConfig {
  readonly vendor: string
  readonly family: string
}

class CopilotAdapter implements LlmAdapter {
  readonly type = 'copilot'
  private readonly selector: vscode.LanguageModelChatSelector
  private cachedModel: vscode.LanguageModelChat | undefined = undefined
  /** 模型缓存时间戳（epoch ms），用于 TTL 失效 */
  private cachedModelTs = 0

  /** 模型缓存 TTL（5 分钟），过期后重新 selectChatModels */
  private static readonly MODEL_CACHE_TTL_MS = 5 * 60 * 1000

  constructor(cfg: CopilotConfig) {
    this.selector = { vendor: cfg.vendor, family: cfg.family }
  }

  async getChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
    return [
      {
        id: 'modux-agent',
        name: 'modux-agent',
        family: 'modux-agent',
        version: '1.0.0',
        tooltip: 'Modux Agent — 你的智能编码助手',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
    ]
  }

  async *chat(req: LlmChatRequest): AsyncIterable<vscode.LanguageModelResponsePart> {
    const model = await this.selectModel()
    if (!model) {
      throw new Error('未找到可用的 Copilot 语言模型，请确保 GitHub Copilot 扩展已安装并启用')
    }

    // 将 AbortSignal 桥接为 VS Code CancellationTokenSource
    const tokenSource = new vscode.CancellationTokenSource()
    const onAbort = () => tokenSource.cancel()

    if (req.signal.aborted) {
      tokenSource.cancel()
    } else {
      req.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const response = await model.sendRequest(
        [...req.messages],
        {
          tools: [...req.tools],
          toolMode: req.toolMode,
        },
        tokenSource.token,
      )
      // VS Code 将 stream 元素类型声明为 unknown 以兼容未来新增 Part 类型，
      // 运行时实际都是 LanguageModelResponsePart 子类，直接透传即可
      for await (const part of response.stream) {
        if (req.signal.aborted) return
        yield part as vscode.LanguageModelResponsePart
      }
    } catch (err) {
      // sendRequest / stream 失败时主动失效缓存，下一次请求重新选模型。
      // 触发场景：Copilot token 失效、用户切换账号、模型 family 被服务端下线等。
      // 取消（CancellationError）不算缓存失效原因，跳过清理。
      if (!req.signal.aborted) {
        log(
          `[Copilot Adapter] sendRequest 失败，失效模型缓存：${err instanceof Error ? err.message : String(err)}`,
        )
        this.cachedModel = undefined
        this.cachedModelTs = 0
      }
      throw err
    } finally {
      req.signal.removeEventListener('abort', onAbort)
      tokenSource.dispose()
    }
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokenCount(text)
  }

  /**
   * 选择底层 Copilot 模型（带缓存）
   * 找不到时返回 undefined，由 chat() 统一抛错
   */
  private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
    // 缓存命中且未过期
    if (
      this.cachedModel !== undefined &&
      Date.now() - this.cachedModelTs < CopilotAdapter.MODEL_CACHE_TTL_MS
    ) {
      return this.cachedModel
    }
    this.cachedModel = undefined // 过期清除，让后续逻辑重新选择

    const models = await vscode.lm.selectChatModels(this.selector)
    if (models.length === 0) {
      log(`[Copilot Adapter] 警告：未找到匹配的模型 selector=${JSON.stringify(this.selector)}`)
      return undefined
    }
    this.cachedModel = models[0]
    this.cachedModelTs = Date.now()
    log(`[Copilot Adapter] 使用模型：${models[0].name}`)
    return models[0]
  }
}

// ── 工厂自注册 ────────────────────────────────────────────────────────────────

const factory: LlmAdapterFactory = {
  type: 'copilot',
  create(cfg) {
    const vendor = typeof cfg.vendor === 'string' ? cfg.vendor : 'copilot'
    const family = typeof cfg.family === 'string' ? cfg.family : 'gpt-4o'
    return new CopilotAdapter({ vendor, family })
  },
}

registerAdapterFactory(factory)
