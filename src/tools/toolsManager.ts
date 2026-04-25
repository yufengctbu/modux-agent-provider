import * as vscode from 'vscode'
import { config } from '../config'
import { log } from '../shared/logger'
import { requestCommandPermission } from './permissions'
import type { ModuxTool } from './types'

// ***
// ToolsManager — 工具注册、查找与执行的统一管理器
//
// 职责：
//   1. register()         — 注册工具实现（由 index.ts 总入口调用）
//   2. findTool()         — 按名称查找工具（供 loop.ts 判断 isReadOnly）
//   3. execute()          — 分发工具调用（含输入校验、权限检查、结果截断）
//   4. getAvailableTools() — 按 config 过滤后向 LLM 声明的工具列表
//   5. getAllTools()       — 返回所有已注册工具
//   6. clear()            — 清空注册表（仅供单元测试使用）
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/**
 * 全局工具结果大小限制（字符数）
 * 工具未设置 maxResultChars 时使用此默认值。
 */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000

/**
 * config.json 键名（camelCase）→ 工具 name（snake_case）映射表
 *
 * config.tools 使用 camelCase（符合 JSON 约定），工具 name 使用 snake_case（符合 LLM 工具调用约定）。
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

// ── ToolsManager ──────────────────────────────────────────────────────────────

class ToolsManager {
  private readonly _tools = new Map<string, ModuxTool>()

  /**
   * 注册工具到内部 Map
   * 同名工具重复注册时后者覆盖前者（方便测试中替换实现）。
   */
  register(tool: ModuxTool): void {
    this._tools.set(tool.name, tool)
  }

  /**
   * 按名称查找工具实例（包含全量工具，不受 config 过滤）
   * 供 loop.ts 判断 isReadOnly 以决定并发策略。
   */
  findTool(name: string): ModuxTool | undefined {
    return this._tools.get(name)
  }

  /**
   * 返回所有已注册工具的只读列表
   */
  getAllTools(): readonly ModuxTool[] {
    return Array.from(this._tools.values())
  }

  /**
   * 向 LLM 声明的工具列表（已按 config 过滤）
   *
   * 只包含 name / description / inputSchema，不暴露 isReadOnly / execute 等实现细节。
   * 每次调用动态过滤（工具数量少，性能无影响）。
   */
  getAvailableTools(): readonly vscode.LanguageModelChatTool[] {
    return Array.from(this._tools.values())
      .filter((tool) => this._isToolEnabled(tool.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }

  /**
   * 工具执行分发器
   *
   * 流程：输入类型守卫 → 工具查找 → 权限检查（run_command）→ 执行 → 结果截断
   *
   * 失败时抛出异常（由 loop.ts 捕获并包装为 ToolResultPart 回传给 LLM）。
   *
   * @param name   工具名称（来自 LLM 的 LanguageModelToolCallPart.name）
   * @param input  工具调用参数（来自 LanguageModelToolCallPart.input）
   * @param token  VS Code 取消令牌
   */
  async execute(name: string, input: unknown, token: vscode.CancellationToken): Promise<string> {
    // 基础输入类型守卫（LLM 偶尔会发送非对象 input）
    if (typeof input !== 'object' || input === null) {
      throw new Error(`Tool "${name}" received invalid input type: ${typeof input}`)
    }

    const tool = this._tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: "${name}"`)
    }

    log(`[Tool] 执行：${name}，输入：${JSON.stringify(input)}`)

    // run_command 执行前请求用户确认
    if (name === 'run_command') {
      const command = (input as { command?: string }).command ?? ''
      const allowed = await requestCommandPermission(command)
      if (!allowed) {
        log(`[Tool] run_command 被用户拒绝：${command}`)
        return `Command execution denied by user: \`${command}\``
      }
    }

    const result = await tool.execute(input, token)

    // 统一截断大输出（对应 Claude Code applyToolResultBudget）
    const limit = tool.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
    if (result.length > limit) {
      log(`[Tool] ${name} 输出截断：${result.length} → ${limit} 字符`)
      return result.slice(0, limit) + `\n... [Output truncated; exceeded ${limit} character limit]`
    }

    return result
  }

  /**
   * 清空注册表
   * @internal 仅供单元测试使用，生产代码不应调用此方法
   */
  clear(): void {
    this._tools.clear()
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────────

  /** 检查工具是否在 config 中被启用 */
  private _isToolEnabled(toolName: string): boolean {
    const configKey = Object.entries(TOOL_CONFIG_KEY_MAP).find(([, v]) => v === toolName)?.[0]
    if (!configKey) return false
    return (config.tools as Record<string, { enabled: boolean }>)[configKey]?.enabled ?? false
  }
}

// ── 单例导出 ──────────────────────────────────────────────────────────────────

/**
 * 全局唯一 ToolsManager 实例
 *
 * VS Code 扩展运行在单一 Extension Host 进程中，Node.js 模块系统保证此实例唯一。
 * 工具注册由 tools/index.ts 在模块初始化阶段完成，后续 import 直接获取已注册状态。
 */
export const toolsManager = new ToolsManager()
