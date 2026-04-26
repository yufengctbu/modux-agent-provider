// ─────────────────────────────────────────────────────────────────────────────
// Adapter 注册总入口
//
// 此模块在首次被 import 时执行（Node.js 模块系统保证仅一次），
// 触发各 Adapter 文件末尾的 registerAdapterFactory() 副作用，
// 将它们全部登记进 provider/registry.ts 中的全局注册表。
//
// 添加新 Adapter：
//   1. 在本目录下创建新文件（实现 LlmAdapter + 文件末尾调用 registerAdapterFactory）
//   2. 在下方 import 该文件
//   3. 在 config/config.json 的 llms 数组中新增一条对应条目
// ─────────────────────────────────────────────────────────────────────────────

import './copilot'
import './moduxBackend'
import './deepseek'
