import { config } from '../config'
import { log } from '../shared/logger'
import type { LlmAdapter, LlmAdapterFactory } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// LLM Adapter 注册表
//
// 生命周期：
//   1. 各 Adapter 模块在被 import 时调用 registerAdapterFactory() 把工厂登记进来
//   2. 首次调用 getActiveAdapter() 时，根据 config.llms 中第一个 enabled 条目
//      查到对应工厂并实例化，结果缓存为 active
//   3. 后续调用直接返回缓存实例，避免重复建立连接 / 选模型等副作用
//
// 按类型查找：getAdapterByType(type) 根据 type 在 config.llms 中查找配置并
//   实例化，结果按 type 独立缓存，与 active 互不干扰。
//
// 配置热切换：本阶段不支持。修改 config.ts 需重新构建扩展；测试可用
// resetActiveAdapter() 清空缓存。
// ─────────────────────────────────────────────────────────────────────────────

const factories = new Map<string, LlmAdapterFactory>()
let active: LlmAdapter | null = null
/** 按 type 缓存已实例化的 Adapter（供 getAdapterByType 使用，与 active 独立） */
const adapterCache = new Map<string, LlmAdapter>()

/**
 * 注册一个 Adapter 工厂
 *
 * 重复注册同 type 会覆盖先前的工厂（方便测试 stub），但会打 warn 日志。
 */
export function registerAdapterFactory(factory: LlmAdapterFactory): void {
  if (factories.has(factory.type)) {
    log(`[Registry] 警告：覆盖已存在的 Adapter 工厂 type=${factory.type}`)
  }
  factories.set(factory.type, factory)
  log(`[Registry] 已注册 Adapter 工厂：${factory.type}`)
}

/**
 * 获取当前激活的 Adapter（懒加载 + 缓存）
 *
 * 失败场景（直接抛错，由调用侧决定如何向用户呈现）：
 *   - config.llms 中不存在 enabled:true 的条目
 *   - 条目的 type 未在 factories 中注册
 */
export function getActiveAdapter(): LlmAdapter {
  if (active) return active

  const entry = config.llms.find((e) => e.enabled === true)
  if (!entry) {
    throw new Error('config.llms 中未启用任何 LLM 适配器，请至少将一项 enabled 设为 true')
  }

  const factory = factories.get(entry.type)
  if (!factory) {
    throw new Error(
      `未知的 LLM 适配器类型：${entry.type}（已注册：${[...factories.keys()].join(', ') || '无'}）`,
    )
  }

  log(`[Registry] 激活 Adapter：type=${entry.type}`)
  active = factory.create(entry as unknown as Record<string, unknown>)
  return active
}

/**
 * 重置激活的 Adapter 缓存
 * 仅用于测试或未来的配置热重载场景
 */
export function resetActiveAdapter(): void {
  active = null
}

/**
 * 按 type 获取指定 Adapter（懒加载 + 按 type 独立缓存）
 *
 * 与 getActiveAdapter() 不同，此函数忽略 enabled 标志，
 * 直接按 type 在 config.llms 中查找配置并实例化。
 * 用于特定 Chat Participant（如 @modux-agent-deepseek）强制使用指定 Adapter。
 *
 * @throws 工厂未注册时抛错
 */
export function getAdapterByType(type: string): LlmAdapter {
  if (adapterCache.has(type)) return adapterCache.get(type)!

  const factory = factories.get(type)
  if (!factory) {
    throw new Error(
      `未知的 LLM 适配器类型：${type}（已注册：${[...factories.keys()].join(', ') || '无'}）`,
    )
  }

  const entry = config.llms.find((e) => e.type === type)
  const cfg = entry ? (entry as unknown as Record<string, unknown>) : {}

  log(`[Registry] 按类型实例化 Adapter：type=${type}`)
  const adapter = factory.create(cfg)
  adapterCache.set(type, adapter)
  return adapter
}

/**
 * 从任意配置对象创建 Adapter 实例（不缓存，每次调用返回新实例）。
 *
 * 用于需要独立 Adapter 配置的场景（如 compact.llm 压缩专用配置），
 * 与 getActiveAdapter() / getAdapterByType() 的缓存逻辑互不干扰。
 *
 * @param entryConfig  适配器配置，必须包含 `type` 字段
 * @throws type 缺失或工厂未注册时抛错
 */
export function createAdapterFromEntry(entryConfig: Record<string, unknown>): LlmAdapter {
  const type = typeof entryConfig['type'] === 'string' ? entryConfig['type'] : undefined
  if (!type) {
    throw new Error('createAdapterFromEntry：配置对象缺少 type 字段')
  }
  const factory = factories.get(type)
  if (!factory) {
    throw new Error(
      `createAdapterFromEntry：未知适配器类型 ${type}（已注册：${[...factories.keys()].join(', ') || '无'}）`,
    )
  }
  log(`[Registry] 创建独立 Adapter 实例：type=${type}`)
  return factory.create(entryConfig)
}

/** 压缩专用 Adapter 缓存（独立于 active，懒加载） */
let compactAdapter: LlmAdapter | null = null

/**
 * 获取用于上下文压缩的 LLM Adapter。
 *
 * 优先使用 config.compact.llm 中的专用配置（适合配置轻量/低成本模型做摘要）；
 * 未配置时回退到当前激活的主 Adapter。
 *
 * 结果按进程生命周期缓存（与 active 独立），可通过 resetCompactAdapter() 清空。
 */
export function getCompactAdapter(): LlmAdapter {
  if (compactAdapter) return compactAdapter

  const compactLlmCfg = config.compact.llm as Record<string, unknown> | undefined

  if (compactLlmCfg && typeof compactLlmCfg['type'] === 'string') {
    log(`[Registry] 初始化压缩专用 Adapter：type=${compactLlmCfg['type']}`)
    compactAdapter = createAdapterFromEntry(compactLlmCfg)
    return compactAdapter
  }

  log('[Registry] 未配置压缩专用 LLM，回退到激活 Adapter')
  return getActiveAdapter()
}

/**
 * 重置压缩专用 Adapter 缓存（仅用于测试）
 */
export function resetCompactAdapter(): void {
  compactAdapter = null
}
