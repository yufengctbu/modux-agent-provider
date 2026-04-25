import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'
import { askUserTool } from './askUserTool'
import { editFileTool } from './editTool'
import { findFilesTool } from './globTool'
import { lspTool } from './lspTool'
import { readFileTool, listDirTool } from './readFileTool'
import { searchCodeTool } from './grepTool'
import { runCommandTool } from './bashTool'
import { todoWriteTool } from './todoTool'
import { webFetchTool } from './webFetchTool'
import { webSearchTool } from './webSearchTool'
import { writeFileTool } from './writeFileTool'
import type { ModuxTool } from './types'

// ***
// 工具注册表
//
// 职责：
//   1. 汇总所有工具实现（ALL_TOOLS）
//   2. 按 config.tools.xxx.enabled 过滤，生成向 LLM 声明的工具列表（AVAILABLE_TOOLS）
//   3. 分发工具调用请求（executeTool），统一做输入校验和结果截断
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/**
 * 全局工具结果大小限制（字符数）
 * 工具未设置 maxResultChars 时使用此默认值，保守取 20000 适配 Copilot token 限制。
 */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000

// ── 工具列表 ──────────────────────────────────────────────────────────────────

/**
 * 全量工具列表（不受 config 控制）
 * 添加新工具：在此数组中追加，并在 TOOL_KEY_MAP 中注册映射关系。
 */
const ALL_TOOLS: ModuxTool[] = [
  readFileTool, // read_file   — 读取文件（只读）
  listDirTool, // list_dir    — 列出目录（只读）
  findFilesTool, // find_files  — glob 文件发现（只读）
  searchCodeTool, // search_code — 代码内容搜索（只读）
  editFileTool, // edit_file   — str_replace 精准编辑（写）
  writeFileTool, // write_file  — 全量写文件（写，危险）
  webFetchTool, // web_fetch   — 网页内容抓取（只读）
  webSearchTool, // web_search  — 网页关键词搜索（只读）
  lspTool, // lsp_info    — LSP 诊断/定义/引用查询（只读）
  todoWriteTool, // todo_write  — 会话任务清单（写）
  askUserTool, // ask_user    — 向用户提问（只读）
  runCommandTool, // run_command — 执行 shell 命令（写，危险）
]

/**
 * config.json 键名（camelCase）→ 工具 name（snake_case）映射表
 *
 * config.tools 使用 camelCase（符合 JSON 约定），工具 name 使用 snake_case（符合 LLM 工具调用约定）。
 * 此映射表在两者之间做桥接，避免硬编码字符串散落在各处。
 */
const TOOL_CONFIG_KEY_MAP: Record<string, string> = {
  readFile: 'read_file',
  listDir: 'list_dir',
  findFiles: 'find_files',
  searchCode: 'search_code',
  editFile: 'edit_file',
  writeFile: 'write_file',
  webFetch: 'web_fetch',
  webSearch: 'web_search',
  lspInfo: 'lsp_info',
  todoWrite: 'todo_write',
  askUser: 'ask_user',
  runCommand: 'run_command',
}

// ── 工具过滤 ──────────────────────────────────────────────────────────────────

/** 检查工具是否在 config 中被启用 */
function isToolEnabled(toolName: string): boolean {
  const configKey = Object.entries(TOOL_CONFIG_KEY_MAP).find(([, v]) => v === toolName)?.[0]
  if (!configKey) return false
  return (config.tools as Record<string, { enabled: boolean }>)[configKey]?.enabled ?? false
}

/**
 * 向 LLM 声明的工具列表（已按 config 过滤）
 *
 * 只包含 name / description / inputSchema，不暴露 isReadOnly / execute 等实现细节。
 * 在扩展激活时计算一次，运行期不变。
 */
export const AVAILABLE_TOOLS: readonly vscode.LanguageModelChatTool[] = ALL_TOOLS.filter((tool) =>
  isToolEnabled(tool.name),
).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))

/**
 * 按工具名查找工具实例（包含全量工具，不受 config 过滤）
 * 供 Phase 5 并发执行时判断 isReadOnly。
 */
export function findTool(toolName: string): ModuxTool | undefined {
  return ALL_TOOLS.find((t) => t.name === toolName)
}

// ── 工具执行 ──────────────────────────────────────────────────────────────────

/**
 * 工具执行分发器
 *
 * 流程：输入类型守卫 → 工具查找 → 执行 → 结果截断
 *
 * 失败时抛出异常（由 loop.ts 捕获并包装为 ToolResultPart 回传给 LLM）。
 *
 * @param name   工具名称（来自 LLM 的 LanguageModelToolCallPart.name）
 * @param input  工具调用参数（来自 LanguageModelToolCallPart.input）
 * @param token  VS Code 取消令牌
 */
export async function executeTool(
  name: string,
  input: unknown,
  token: vscode.CancellationToken,
): Promise<string> {
  // 基础输入类型守卫（LLM 偶尔会发送非对象 input）
  if (typeof input !== 'object' || input === null) {
    throw new Error(`Tool "${name}" received invalid input type: ${typeof input}`)
  }

  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (!tool) {
    throw new Error(`Unknown tool: "${name}"`)
  }

  log(`[Tool] 执行：${name}，输入：${JSON.stringify(input)}`)

  const result = await tool.execute(input, token)

  // registry 层统一截断大输出（对应 Claude Code applyToolResultBudget）
  const limit = tool.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  if (result.length > limit) {
    log(`[Tool] ${name} 输出截断：${result.length} → ${limit} 字符`)
    return result.slice(0, limit) + `\n... [Output truncated; exceeded ${limit} character limit]`
  }

  return result
}
