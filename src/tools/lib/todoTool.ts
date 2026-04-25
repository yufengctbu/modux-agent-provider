import { log } from '../../shared/logger'
import type { ModuxTool } from '../types'

// ***
// 工具：会话任务清单
//   - todo_write  写入/更新当前会话的 TODO 列表（全量替换）
//
// 设计原则（参照 Claude Code TodoWriteTool）：
//   - AI 主动在复杂多步任务时创建并实时更新任务清单
//   - 每次调用替换完整列表（而非增量 patch），确保状态一致
//   - 任务状态：pending → in_progress → completed
//   - 同一时刻最多只有 1 个 in_progress 任务
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 状态对应的 Unicode 图标，用于日志输出可读性 */
const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

type TodoStatus = 'pending' | 'in_progress' | 'completed'

interface TodoItem {
  /** 任务描述（祈使句，如 "Update registry.ts imports"） */
  content: string
  /**
   * 进行时描述（如 "Updating registry.ts imports"）
   * 用于 UI 展示当前正在进行的动作。可选，便于渐进迁移。
   */
  activeForm?: string
  /** 当前状态 */
  status: TodoStatus
}

interface TodoWriteInput {
  todos: TodoItem[]
}

// ── 会话状态 ──────────────────────────────────────────────────────────────────

/**
 * 当前会话的 TODO 列表（内存存储，不落盘）
 * 每次 todo_write 调用完整替换此变量。
 */
let sessionTodos: TodoItem[] = []

/** 返回只读快照，供外部（如 context.ts）展示当前任务状态 */
export function getSessionTodos(): readonly TodoItem[] {
  return sessionTodos
}

// ── todo_write ────────────────────────────────────────────────────────────────

export const name = 'todo_write'

export const todoWriteTool: ModuxTool = {
  name,
  description:
    'Create and manage a structured task list for the current session. Use this to track progress on complex multi-step tasks. ' +
    'Each call REPLACES the entire list — always include all tasks (completed, in_progress, and pending). ' +
    'Status values: "pending" (not started), "in_progress" (currently working — max 1 at a time), "completed" (done). ' +
    'Provide both "content" (imperative form, e.g. "Run tests") and "activeForm" (present-continuous form, e.g. "Running tests") for each task. ' +
    'Use proactively for tasks with 3+ steps; skip for trivial single-step requests.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete updated task list (replaces the previous list entirely)',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description:
                'Task description in imperative form (e.g. "Update registry imports", "Run tests")',
            },
            activeForm: {
              type: 'string',
              description:
                'Same task in present-continuous form, shown while the task is in_progress (e.g. "Updating registry imports", "Running tests")',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '"pending" | "in_progress" (max 1 at a time) | "completed"',
            },
          },
          required: ['content', 'activeForm', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: false,

  async execute(input: unknown): Promise<string> {
    const { todos } = input as TodoWriteInput

    // 基本校验：in_progress 不超过 1 个
    const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
    if (inProgressCount > 1) {
      return `Error: ${inProgressCount} tasks are marked "in_progress". Only 1 task should be in progress at a time.`
    }

    // 全量替换（activeForm 缺失时回退到 content，保证向后兼容）
    sessionTodos = todos.map((t) => ({
      content: t.content,
      activeForm: t.activeForm ?? t.content,
      status: t.status,
    }))

    // 记录到输出通道，让用户可见
    log('[TodoList]\n' + formatTodos(sessionTodos))

    return formatTodos(sessionTodos)
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 将 todo 列表格式化为可读文本 */
function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(todo list is empty)'

  const lines = todos.map((t, i) => {
    const icon = STATUS_ICON[t.status]
    const idx = String(i + 1).padStart(String(todos.length).length)
    // in_progress 任务使用 activeForm 展示当前动作，其它状态用 content
    const label = t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content
    return `${idx}. ${icon} ${label}`
  })

  const done = todos.filter((t) => t.status === 'completed').length
  const total = todos.length
  const summary = `Progress: ${done}/${total} completed`

  return lines.join('\n') + `\n\n${summary}`
}
