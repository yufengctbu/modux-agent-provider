import { toolsManager } from './toolsManager'
import { readFileTool } from './lib/readFileTool'
import { listDirTool } from './lib/listDirTool'
import { findFilesTool } from './lib/globTool'
import { searchCodeTool } from './lib/grepTool'
import { editFileTool } from './lib/editTool'
import { writeFileTool } from './lib/writeFileTool'
import { runCommandTool } from './lib/bashTool'
import { lspTool } from './lib/lspTool'
import { webFetchTool } from './lib/webFetchTool'
import { webSearchTool } from './lib/webSearchTool'
import { askUserTool } from './lib/askUserTool'
import { todoWriteTool } from './lib/todoTool'

// ***
// 工具注册总入口
//
// 此模块在首次 import 时执行（Node.js 模块系统保证只执行一次），
// 将所有工具实现注册到全局 toolsManager 实例。
//
// 添加新工具：
//   1. 在 lib/ 目录下创建工具文件（实现 ModuxTool 接口并导出 name 常量）
//   2. 在此文件中 import 并调用 toolsManager.register()
//   3. 在 config/config.json 的 tools 节点中添加对应的 enabled 配置
// ***

toolsManager.register(readFileTool)
toolsManager.register(listDirTool)
toolsManager.register(findFilesTool)
toolsManager.register(searchCodeTool)
toolsManager.register(editFileTool)
toolsManager.register(writeFileTool)
toolsManager.register(runCommandTool)
toolsManager.register(lspTool)
toolsManager.register(webFetchTool)
toolsManager.register(webSearchTool)
toolsManager.register(askUserTool)
toolsManager.register(todoWriteTool)

export { toolsManager } from './toolsManager'
export type { ModuxTool } from './types'
