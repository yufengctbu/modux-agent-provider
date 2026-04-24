import rawConfig from './config.json'

/**
 * 运行时配置入口
 *
 * 使用方式：
 *   import { config } from '../config'
 *   config.backend.enabled              // boolean
 *   config.tools.readFile.enabled       // boolean
 *   config.agent.maxLoopRounds          // number
 *
 * 修改配置：直接编辑 src/config/config.json，然后重新执行 npm run build。
 * 此文件只导出只读对象，所有字段在 TypeScript 层面均不可写入。
 *
 * ── 字段说明 ────────────────────────────────────────────────────────────────
 * backend
 *   .enabled        是否将聊天请求转发到自定义后端服务
 *   .url            后端接口地址
 *   .forwardTools   是否将 VS Code 工具附件（#file 等）转发给后端
 *
 * llm
 *   .vendor         底层 Copilot 模型提供方（固定为 "copilot"）
 *   .family         底层模型系列，可改为 "gpt-4o-mini" / "claude-sonnet-4-5" 等
 *
 * tools             各工具开关（对应 chat/tools/ 下的每个工具实现）
 *   .readFile       读取文件内容（默认开启）
 *   .listDir        列出目录（默认开启）
 *   .editFile       str_replace 精准编辑（默认开启）
 *   .searchCode     代码搜索（默认开启）
 *   .writeFile      全量写文件（默认关闭，危险操作）
 *   .runCommand     执行 shell 命令（默认关闭，危险操作）
 *     .timeoutMs    命令执行超时（毫秒）
 *
 * agent
 *   .systemPrompt           追加到 DEFAULT_SYSTEM_PROMPT 之后的自定义指令
 *   .maxLoopRounds          Agent Loop 单次任务最大循环轮次
 *   .compactThreshold       触发 LLM 历史摘要压缩的消息轮数阈值（优先路径）
 *   .maxHistoryTurns        摘要失败时的兜底硬截断轮数（应高于 compactThreshold）
 *   .compactHistoryEnabled  是否启用 LLM 摘要压缩（false 时直接截断）
 */

/** 递归只读类型，确保嵌套字段也不可写 */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

export const config: DeepReadonly<typeof rawConfig> = rawConfig
