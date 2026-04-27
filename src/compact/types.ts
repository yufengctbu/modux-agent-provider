import type * as vscode from 'vscode'
import type { LlmAdapter } from '../provider/types'

// ─────────────────────────────────────────────────────────────────────────────
// 上下文压缩模块 — 共享类型定义
//
// 此文件只包含纯类型定义，不包含任何运行时逻辑，避免循环依赖。
// ─────────────────────────────────────────────────────────────────────────────

// ── Layer 4: LLM 摘要压缩 ────────────────────────────────────────────────────

/**
 * LLM 摘要压缩操作的返回结果
 *
 * 使用 Result 类型而非异常，让调用方可以显式处理失败路径。
 */
export type CompactResult =
  | { readonly success: true; readonly messages: vscode.LanguageModelChatMessage[] }
  | { readonly success: false; readonly error: string }

/**
 * 调用 LLM 生成历史摘要的配置项
 */
export interface CompactWithLlmOptions {
  /** 用于生成摘要的 LLM Adapter */
  readonly adapter: LlmAdapter
  /** 摘要请求超时（ms）—— 超时后 abort，降级为截断 */
  readonly timeoutMs: number
  /** 外部取消信号（可选，优先级高于超时） */
  readonly signal?: AbortSignal
  /** 摘要时 context 过长时的最大重试次数（Layer 5） */
  readonly maxPtlRetries: number
}

// ── Layer 3: Token 感知自动压缩 ───────────────────────────────────────────────

/**
 * autoCompact 每轮调用所需的选项
 *
 * 所有数值字段均来自 config.compact，由 loop.ts 组装后传入，
 * 避免 compact 模块直接读取 config（保持模块的可测试性）。
 */
export interface AutoCompactOptions {
  /** 当前消息列表的 token 估算值（由 tokenEstimator 提供） */
  readonly tokenEstimate: number
  /** 模型上下文窗口大小（token 数） */
  readonly contextWindowSize: number
  /** 触发 LLM 摘要的比例阈值（0–1，典型值 0.75） */
  readonly thresholdRatio: number
  /** 强制硬截断的比例阈值（0–1，典型值 0.92） */
  readonly hardLimitRatio: number
  /** 熔断阈值：连续失败达此值后不再触发 LLM 摘要，只做截断 */
  readonly maxFailures: number
  /** 当前连续失败次数（由 loop 跨轮次维护） */
  readonly failureCount: number
  /** 传给 Layer 4 执行摘要 */
  readonly compactOpts: CompactWithLlmOptions
  /** 固定前缀消息数（不参与压缩，如 System Prompt + 工作区上下文） */
  readonly prefixCount: number
  /** 兜底截断时保留最近多少条历史消息 */
  readonly maxHistoryTurns: number
}

/**
 * autoCompact 的返回结果
 *
 * - compacted: 是否成功执行了 LLM 摘要压缩（loop 据此重置失败计数器）
 * - compactFailed: LLM 摘要压缩已触发但失败（loop 据此递增失败计数器）
 * - messages: 压缩/截断后的完整消息列表（含前缀）
 */
export interface AutoCompactResult {
  readonly messages: vscode.LanguageModelChatMessage[]
  readonly compacted: boolean
  readonly compactFailed: boolean
}

// ── 响应式重试包裹器 ──────────────────────────────────────────────────────────

/**
 * withReactiveCompact 包裹器选项
 */
export interface ReactiveCompactOptions {
  /** 获取当前历史消息（不含固定前缀，由 ContextBuilder 提供） */
  getHistoryMessages(): vscode.LanguageModelChatMessage[]
  /** 回写压缩后的历史消息（由 ContextBuilder 提供） */
  replaceHistoryMessages(msgs: vscode.LanguageModelChatMessage[]): void
  /** 传给 Layer 4 执行摘要 */
  readonly compactOpts: CompactWithLlmOptions
  /** 最大重试次数（context 过长错误时的重试上限） */
  readonly maxRetries: number
  /** 固定前缀消息数（不参与压缩） */
  readonly prefixCount: number
  /** 兜底截断时保留最近多少条历史消息 */
  readonly maxHistoryTurns: number
  /** 是否启用响应式重试（false 时直接 throw 原始错误） */
  readonly enabled: boolean
}
