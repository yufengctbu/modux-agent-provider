import * as vscode from 'vscode'
import type { FileStateCache } from '../shared/fileStateCache'

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
    readonly properties: Record<
      string,
      {
        readonly type: string
        readonly description: string
        readonly items?: {
          readonly type: string
          readonly properties?: Record<string, unknown>
          readonly required?: readonly string[]
        }
        readonly enum?: readonly string[]
      }
    >
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
   *
   * 注意：仅截断 ToolResult.text 字符串，附带的图像/数据块不参与字符截断
   * （图像由 imageReader 在源头做大小护栏）。
   */
  readonly maxResultChars?: number

  /**
   * 工具执行函数
   *
   * @param input  LLM 生成的调用参数（已通过 registry 的基础类型守卫）
   * @param ctx    执行上下文：取消令牌、文件状态缓存等共享资源
   * @returns      工具执行结果：纯文本字符串或带附件的结构化结果
   *               失败时返回描述性错误字符串，而非抛出异常（让 LLM 感知并决策）
   */
  execute(input: unknown, ctx: ToolExecuteContext): Promise<ToolExecuteResult>
}

/**
 * 工具执行上下文
 *
 * 通过对象传参（而非位置参数），便于未来扩展新字段时不破坏 ABI。
 */
export interface ToolExecuteContext {
  /** VS Code 取消令牌：用户中途取消任务时触发 */
  readonly token: vscode.CancellationToken

  /**
   * 已读文件状态缓存（用于 read_file 去重 / edit/write 失效）
   *
   * 由 ToolsManager 注入；若工具不关心文件状态可忽略。
   */
  readonly fileState: FileStateCache
}

/**
 * 工具执行结果
 *
 * 兼容两种形态：
 *   - string：常规文本结果（绝大多数工具）
 *   - ToolResult 对象：含附件（image/data part）的富结果
 *
 * 选择不分裂为不同接口，让纯文本工具保持最小改造成本。
 */
export type ToolExecuteResult = string | ToolResult

/**
 * 富工具结果（带附件）
 *
 * 设计来源：Claude Code mapToolResultToToolResultBlockParam，将单个工具结果
 * 拆为 text + image/document 块，下游适配器按需序列化。
 */
export interface ToolResult {
  /**
   * 文本主体（始终存在）
   *
   * 纯文本表述，LLM 必须能从这段文字中获得"工具做了什么、结果是什么"，
   * 即使 attachments 因下游适配器不支持视觉而被丢弃，也不会丢失关键信息。
   */
  readonly text: string

  /**
   * 附件列表（可选）
   *
   * 当前仅支持图像类型。下游 loop 会把每个附件转成
   * vscode.LanguageModelDataPart.image() 并放入 ToolResultPart.content。
   *
   * 不支持视觉的 LLM 适配器（如纯文本 DeepSeek）会自动剥离图像附件，
   * 仅保留 text 字段，并在剥离时附加一行说明（参见 deepseek.ts 的转换逻辑）。
   */
  readonly attachments?: ReadonlyArray<ToolResultAttachment>
}

/** 工具结果附件（目前只有 image 一种） */
export type ToolResultAttachment = ImageAttachment

/** 图像附件 */
export interface ImageAttachment {
  readonly kind: 'image'
  /** 原始字节（PNG/JPEG/GIF/WebP） */
  readonly data: Uint8Array
  /** MIME 类型（image/png 等） */
  readonly mimeType: string
}
