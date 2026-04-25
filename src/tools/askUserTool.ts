import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ***
// 工具：向用户提问
//   - ask_user  通过 VS Code 快速选择框或输入框向用户提问，获取明确答案
//
// 设计原则（参照 Claude Code AskUserQuestionTool）：
//   - 在存在歧义时主动询问，而非乱猜
//   - 提供选项时用 showQuickPick（用户可直接点选）
//   - 总是附加"其他..."选项，允许用户自由输入
//   - 用户取消（按 ESC）时返回 cancelled 信号
// ***

// ── ask_user ──────────────────────────────────────────────────────────────────

interface AskUserInput {
  question: string
  options?: string[]
}

/** 其他/自定义输入选项的标签 */
const OTHER_LABEL = 'Other...'

export const askUserTool: ModuxTool = {
  name: 'ask_user',
  description:
    'Ask the user a clarifying question via a VS Code dialog and return their answer. ' +
    "Use this to resolve ambiguity before acting — do not guess when the user's intent is unclear. " +
    'Provide "options" for multiple-choice questions (a free-text "Other..." option is always appended automatically). ' +
    'Omit "options" for open-ended questions that require a typed answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask. Be specific and end with a question mark.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of choices for the user to pick from (2–6 items recommended). ' +
          'Omit for free-text questions.',
      },
    },
    required: ['question'],
  },
  isReadOnly: true,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { question, options } = input as AskUserInput

    // 有选项：用 QuickPick（点选 + 自由输入兜底）
    if (options && options.length > 0) {
      return askWithOptions(question, options, token)
    }

    // 无选项：用 InputBox（自由文本）
    return askFreeText(question, token)
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 带选项的多选问答（QuickPick） */
async function askWithOptions(
  question: string,
  options: string[],
  token: vscode.CancellationToken,
): Promise<string> {
  // 构建 QuickPickItem 列表，末尾追加"其他..."
  const items: vscode.QuickPickItem[] = [
    ...options.map((label) => ({ label })),
    { label: OTHER_LABEL, description: 'Type a custom answer' },
  ]

  // 创建 QuickPick 实例，绑定取消令牌
  const qp = vscode.window.createQuickPick()
  qp.placeholder = question
  qp.title = 'Modux Agent — Question'
  qp.items = items
  qp.ignoreFocusOut = true

  const result = await new Promise<string | undefined>((resolve) => {
    // 取消令牌触发时关闭 QuickPick
    token.onCancellationRequested(() => {
      qp.hide()
      resolve(undefined)
    })

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0]?.label
      qp.hide()
      resolve(selected)
    })

    qp.onDidHide(() => resolve(undefined))
    qp.show()
  })

  qp.dispose()

  if (result === undefined) {
    return 'User cancelled the question.'
  }

  // 用户选择"其他..."→ 弹出输入框收集自由文本
  if (result === OTHER_LABEL) {
    return askFreeText(question, token)
  }

  return `User selected: ${result}`
}

/** 自由文本输入（InputBox） */
async function askFreeText(question: string, token: vscode.CancellationToken): Promise<string> {
  // 取消令牌通过 CancellationTokenSource 桥接给 showInputBox
  const cts = new vscode.CancellationTokenSource()
  token.onCancellationRequested(() => cts.cancel())

  const answer = await vscode.window.showInputBox(
    {
      prompt: question,
      title: 'Modux Agent — Question',
      ignoreFocusOut: true,
    },
    cts.token,
  )

  cts.dispose()

  if (answer === undefined || answer === '') {
    return 'User cancelled or provided no answer.'
  }

  return `User answered: ${answer}`
}
