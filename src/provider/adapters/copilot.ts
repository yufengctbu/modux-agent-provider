import * as vscode from 'vscode'
import { log } from '../../shared/logger'
import { registerAdapterFactory } from '../registry'
import type { LlmAdapter, LlmAdapterFactory, LlmChatRequest } from '../types'

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

/** 估算 token 数的字符/token 比例（4 字符 ≈ 1 token，粗略公式） */
const CHARS_PER_TOKEN = 4

/** Copilot 适配器配置结构（来自 config.llms 中 type=copilot 的条目） */
interface CopilotConfig {
  readonly vendor: string
  readonly family: string
}

class CopilotAdapter implements LlmAdapter {
  readonly type = 'copilot'
  private readonly selector: vscode.LanguageModelChatSelector

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
        { tools: [...req.tools] },
        tokenSource.token,
      )
      // VS Code 将 stream 元素类型声明为 unknown 以兼容未来新增 Part 类型，
      // 运行时实际都是 LanguageModelResponsePart 子类，直接透传即可
      for await (const part of response.stream) {
        if (req.signal.aborted) return
        yield part as vscode.LanguageModelResponsePart
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort)
      tokenSource.dispose()
    }
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  /**
   * 选择底层 Copilot 模型（首次匹配项）
   * 找不到时返回 undefined，由 chat() 统一抛错
   */
  private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels(this.selector)
    if (models.length === 0) {
      log(`[Copilot Adapter] 警告：未找到匹配的模型 selector=${JSON.stringify(this.selector)}`)
      return undefined
    }
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
