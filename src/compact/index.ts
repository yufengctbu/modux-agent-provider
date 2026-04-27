// ─────────────────────────────────────────────────────────────────────────────
// shared/compact — 上下文压缩模块 总出口
//
// 目录结构说明：
//
//   index.ts              ← 本文件：模块唯一公开入口
//   types.ts              ← 内部类型定义（仅供 layers/ 和 CompactManager 使用）
//   helpers.ts            ← 底层工具函数（clone / sumLength / isContextTooLong）
//   CompactManager.ts     ← 高层外观类（loop.ts 唯一接触点）
//   layers/
//     layer1-micro.ts        Layer 1: MicroCompact  — 旧工具结果替换为占位文本
//     layer2-stripImages.ts  Layer 2: StripImages   — 摘要前剥离图像 DataPart
//     layer3-auto.ts         Layer 3: AutoCompact   — Token 预算检测 + 触发决策
//     layer4-summary.ts      Layer 4: LLM Summary   — 单次 LLM 摘要调用
//     layer5-retry.ts        Layer 5: PTL Retry     — 渐进截断 + LLM 重试链
//     layer6-truncate.ts     Layer 6: HardTruncate  — 最终兜底硬截断
//     reactive.ts            Reactive Wrapper       — 响应式 context 过长重试
//
// 外部调用模式（极简，外部只传数据）：
//
//   import { CompactManager } from '../shared/compact'
//   const mgr = new CompactManager(adapter, contextBuilder)
//   messages = await mgr.applyAutoCompact(messages)          // Layer 3
//   for await (const p of mgr.wrapChat(chatFn, messages)) {} // Reactive
//
// ─────────────────────────────────────────────────────────────────────────────

// ── 主外观类（loop.ts 唯一需要导入的内容）────────────────────────────────────
export { CompactManager, initCompactHistory } from './CompactManager'
export type { CompactContextBuilder } from './CompactManager'

// ── Layer 1 微压缩（ContextBuilder 每轮构建消息时调用）──────────────────────
export { applyMicrocompaction } from './layers/micro'
export type { MicroCompactResult } from './layers/micro'

// ── 工具函数（helpers.ts 中外部偶尔需要的部分）──────────────────────────────
export { isContextTooLongError } from './utils'
