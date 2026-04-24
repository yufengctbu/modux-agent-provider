import * as vscode from 'vscode'
import { log } from '../../shared/logger'

/**
 * 向 LLM 声明的工具列表
 *
 * 每个工具需同时在此处「声明」（让 LLM 感知）并在 executeTool 中「实现」。
 * LLM 会根据 description 和 inputSchema 决定何时调用哪个工具。
 *
 * 添加工具示例：
 * {
 *   name: 'read_file',
 *   description: '读取工作区中指定路径的文件内容',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       path: { type: 'string', description: '相对于工作区根目录的文件路径' },
 *     },
 *     required: ['path'],
 *   },
 * },
 */
export const AVAILABLE_TOOLS: vscode.LanguageModelChatTool[] = []

/**
 * 工具执行器：根据工具名分发到对应的实现函数
 *
 * 返回字符串作为工具执行结果，会作为 ToolResultPart 回传给 LLM，
 * LLM 可基于此结果继续推理或生成最终答案。
 *
 * 添加工具时，在 switch 中补充对应 case 即可：
 * case 'read_file':
 *   return await handleReadFile(input as { path: string }, token)
 */
export async function executeTool(
  name: string,
  input: unknown,
  _token: vscode.CancellationToken,
): Promise<string> {
  log(`[Tool] 执行：${name}，输入：${JSON.stringify(input)}`)

  switch (name) {
    // case 'read_file':
    //   return await handleReadFile(input as { path: string }, _token)
    default:
      throw new Error(`未声明的工具：${name}`)
  }
}
