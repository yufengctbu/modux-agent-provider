import * as vscode from 'vscode'

// ─────────────────────────────────────────────────────────────────────────────
// 工具系统核心接口
// 所有工具实现必须遵守此接口，registry 依赖它完成注册、过滤与执行分发。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modux Agent 工具接口
 *
 * 每个工具由「声明」和「执行」两部分组成：
 *   - 声明（name / description / inputSchema）：传给 LLM，让模型知道何时调用
 *   - 执行（execute）：工具调用发生后，由 registry 分发到此函数
 *
 * 工具设计原则（来自 Claude Code Tool.ts）：
 *   - isReadOnly = true  → 不修改工作区状态，可在同轮并发执行
 *   - isReadOnly = false → 有写副作用，串行执行（保证顺序一致性）
 *   - execute 失败时返回描述性错误字符串，而非抛出异常（让 LLM 感知并决策）
 */
export interface ModuxTool {
  /** 工具名称（snake_case），LLM 通过此名称发起调用 */
  readonly name: string

  /** 工具功能描述，LLM 据此判断何时调用该工具 */
  readonly description: string

  /**
   * 工具输入参数的 JSON Schema（子集）
   * LLM 按此 schema 生成结构化输入，registry 做基础类型守卫后传入 execute
   */
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Record<string, { readonly type: string; readonly description: string }>
    readonly required?: readonly string[]
  }

  /**
   * 是否为只读工具（不修改工作区文件系统或 shell 状态）
   *
   * true  → 同轮多个只读调用可并发执行（Phase 5）
   * false → 写工具，保守串行执行（防止竞争条件）
   * 默认应为 false（保守安全）
   */
  readonly isReadOnly: boolean

  /**
   * 本工具结果的最大字符数
   * 超出部分由 registry 统一截断，防止单个工具撑爆 token 预算。
   * 未设置时 registry 使用全局默认值 DEFAULT_TOOL_RESULT_MAX_CHARS。
   */
  readonly maxResultChars?: number

  /**
   * 工具执行函数
   *
   * @param input  LLM 生成的调用参数（已通过 registry 的基础类型守卫）
   * @param token  VS Code 取消令牌，支持用户中途取消
   * @returns      工具执行结果字符串，回传给 LLM 作为 ToolResultPart
   *               失败时返回描述性错误字符串，而非抛出异常
   */
  execute(input: unknown, token: vscode.CancellationToken): Promise<string>
}
