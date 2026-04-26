import rawConfig from './config.json'

/**
 * 运行时配置入口
 *
 * 使用方式：
 *   import { config } from '../config'
 *   config.llms                         // LLM 适配器条目数组
 *   config.tools.readFile.enabled       // boolean
 *   config.agent.maxLoopRounds          // number
 *
 * 修改配置：直接编辑 src/config/config.json，然后重新执行 npm run build。
 * 此文件只导出只读对象，所有字段在 TypeScript 层面均不可写入。
 *
 * ── 字段说明 ────────────────────────────────────────────────────────────────
 * llms              LLM 适配器条目数组，按顺序查找，采用第一个 enabled:true 的条目
 *   .type           适配器类型标识，必须与 provider/adapters/ 下已注册的工厂匹配
 *                   当前内置：
 *                     "copilot"       通过 vscode.lm 调用 Copilot 的底层模型
 *                     "moduxBackend"  转发至用户自有的 OpenAI-compatible HTTP 服务
 *   .enabled        是否启用此条目
 *   （其余字段）    由具体 Adapter 解释：
 *                     copilot:       vendor / family
 *                     moduxBackend:  url / forwardTools
 *
 * tools             各工具开关（对应 src/tools/ 下的每个工具实现）
 *   .readFile       读取文件内容（默认开启）
 *   .listDir        列出目录（默认开启）
 *   .findFiles      glob 文件路径发现（默认开启）
 *   .searchCode     代码内容搜索（默认开启）
 *   .editFile       str_replace 精准编辑（默认开启）
 *   .writeFile      全量写文件（默认关闭，危险操作）
 *   .webFetch       网页内容抓取（默认开启）
 *   .webSearch      网页关键词搜索（默认开启）
 *   .lspInfo        LSP 诊断/定义/引用查询（默认开启）
 *   .todoWrite      会话任务清单（默认开启）
 *   .askUser        向用户提问（默认开启）
 *   .runCommand     执行 shell 命令（默认关闭，危险操作）
 *     .timeoutMs    命令执行超时（毫秒）
 *
 * agent
 *   .systemPrompt                      追加到 DEFAULT_SYSTEM_PROMPT 之后的自定义指令
 *   .language                          响应语言（如 "Chinese (Simplified)"、"Japanese"）；留空时 AI 自行判断语言
 *   .maxLoopRounds                     Agent Loop 单次任务最大循环轮次
 *   .compactThreshold                  触发 LLM 历史摘要压缩的消息轮数阈值（优先路径）
 *   .maxHistoryTurns                   摘要失败时的兜底硬截断轮数（应高于 compactThreshold）
 *   .compactHistoryEnabled             是否启用 LLM 摘要压缩（false 时直接截断）
 *   .fileReadDedupEnabled              read_file 命中相同文件 + 范围 + mtime 时返回 stub（默认 true）
 *   .maxImageBytes                     单张图像最大字节数，超出则拒绝读取（默认 5 MB）
 *   .microcompactEnabled               是否对历史中的旧 ToolResult 做微压缩（默认 true）
 *   .microcompactKeepRecentToolResults 最近多少条 ToolResult 永远不压缩（默认 6）
 *   .microcompactMinToolResultChars    单条 ToolResult 字符数低于此值时不压缩（默认 400）
 *   .stripImagesInCompact              做 LLM 摘要压缩前是否剥离图像 DataPart（默认 true）
 */

/** 递归只读类型，确保嵌套字段也不可写 */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

export const config: DeepReadonly<typeof rawConfig> = rawConfig
