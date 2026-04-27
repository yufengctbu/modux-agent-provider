import type * as vscode from 'vscode'

// ─────────────────────────────────────────────────────────────────────────────
// LLM Adapter 类型定义
//
// 所有 LLM 接入方（Copilot / 自有后端 / 未来的 OpenAI / Claude 等）都实现
// LlmAdapter 接口，通过同名工厂在模块加载时自注册到 provider/registry.ts。
//
// 调用侧（LmProvider / Agent Loop / History Compaction）通过 getActiveAdapter()
// 拿到当前激活的 Adapter，只感知统一的接口，不关心底层是什么 LLM。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 统一的聊天请求入参
 *
 * - messages: 对话历史 + 当前输入，形态与 vscode.LanguageModelChatMessage 一致
 * - tools:    本轮向 LLM 声明的工具列表，空数组表示纯文本对话
 * - signal:   取消信号，Adapter 内部负责把它桥接到具体的底层取消机制
 *             （Copilot → CancellationTokenSource；自有后端 → fetch signal）
 */
export interface LlmChatRequest {
  readonly messages: readonly vscode.LanguageModelChatMessage[]
  readonly tools: readonly vscode.LanguageModelChatTool[]
  readonly signal: AbortSignal
  /** toolMode — VS Code Chat 模式，映射到 LLM 的 tool_choice 参数 */
  readonly toolMode?: vscode.LanguageModelChatToolMode
}

/**
 * LLM 适配器统一接口
 *
 * 设计要点：
 * - chat() 返回 AsyncIterable<LanguageModelResponsePart>，调用侧按 instanceof
 *   区分 TextPart / ToolCallPart，能力与 VS Code LM API 原生流一致。
 * - 不支持结构化工具调用的适配器（如当前的自有后端）只需 yield TextPart 即可，
 *   Agent Loop 在接收到零个 ToolCallPart 时自然结束循环。
 */
export interface LlmAdapter {
  /** 适配器类型标识，必须与 config.llms[].type 对应 */
  readonly type: string

  /**
   * 向 VS Code 模型选择器暴露的元数据
   * 目前统一呈现单一 "modux-agent" 入口，底层由激活的 Adapter 提供服务
   */
  getChatInformation(): Promise<vscode.LanguageModelChatInformation[]>

  /**
   * 发送聊天请求，按到达顺序流式 yield 响应 Part
   *
   * 异常语义：
   *   - 取消（signal.abort）：Adapter 内部静默终止，不抛出
   *   - 其他异常：按原始错误抛出，由调用侧统一捕获处理
   */
  chat(req: LlmChatRequest): AsyncIterable<vscode.LanguageModelResponsePart>

  /** 粗略估算 token 数，供 VS Code 做请求前预算检查 */
  countTokens(text: string): Promise<number>
}

/**
 * Adapter 工厂
 *
 * registry 在首次调用 getActiveAdapter() 时根据配置中第一个 enabled 条目
 * 的 type 字段查到工厂，再把该条目作为 config 传入 create() 实例化 Adapter。
 */
export interface LlmAdapterFactory {
  readonly type: string
  create(entryConfig: Record<string, unknown>): LlmAdapter
}
