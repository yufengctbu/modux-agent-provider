import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// FileStateCache — 已读文件状态的 LRU 缓存
//
// 设计目的（对应 Claude Code src/utils/fileStateCache.ts）：
//   工具如 read_file 在多轮对话中可能被反复调用读取同一文件。如果文件没有
//   修改，把全文重新塞进上下文是纯粹的浪费。本缓存记录"上次读到的内容指纹"，
//   下次同一文件 + 同一范围的读取，且文件未被修改时，返回 FILE_UNCHANGED_STUB
//   占位符即可，先前的读取结果仍在历史中。
//
// 缓存键：归一化绝对路径（消除 ./ ../ 与 Windows 上的 / vs \ 差异）
// 缓存值：FileState（包含 mtimeMs、读取范围、可选的 content）
//
// 写工具（edit_file / write_file）写入文件后必须调用 invalidate() 清除条目，
// 否则下一轮 read_file 会错误地命中"未修改"分支，把陈旧内容当作有效缓存。
//
// 容量控制：双重上限（最大条目数 + 最大字节数），通过 LRU 淘汰防止内存膨胀。
//   - 最大条目数：避免极小文件场景下 Map 元数据过多
//   - 最大字节数：限制总驻留内存（content 字段可能占用较多）
// ─────────────────────────────────────────────────────────────────────────────

/** 单条文件状态记录 */
export interface FileState {
  /** 上次读取时文件的修改时间（fs.Stats.mtimeMs，毫秒级浮点） */
  readonly timestamp: number
  /** 上次读取的起始行号（1-based），undefined 表示从头读 */
  readonly startLine?: number
  /** 上次读取的结束行号（1-based），undefined 表示读到末尾 */
  readonly endLine?: number
  /**
   * 上次读取后留下的内容快照
   *
   * 仅用于诊断与调试，去重判断只看 (timestamp, startLine, endLine)；
   * 故意保留以便未来扩展（例如 diff 时需要旧内容做对比）。
   * 大文件场景下显著占用内存——通过 maxBytes 限制总驻留量。
   */
  readonly content?: string
}

/** 已读文件的 stub 文本，告诉 LLM 文件内容未变 */
export const FILE_UNCHANGED_STUB =
  '<file-unchanged>\n' +
  'The file content has not changed since you last read it. Refer to the previous tool result for the current content.\n' +
  'If you need to confirm the file is intact, use list_dir or check git status. If you need a different range, call read_file again with new startLine/endLine parameters.\n' +
  '</file-unchanged>'

/** 默认最大缓存条目数（够覆盖单次 Agent 任务常见的访问规模） */
const DEFAULT_MAX_ENTRIES = 256

/** 默认最大缓存内容字节数（25MB，对应 Claude Code 实现） */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

// ── 实现：手写 LRU（避免引入 lru-cache 依赖） ──────────────────────────────────
//
// JavaScript Map 保证插入顺序，命中后通过 delete + set 把条目挪到末尾即可
// 实现 O(1) 的 LRU 淘汰。容量控制时从迭代器头部取最早条目剔除。
//
// 该结构对单线程调用足够，VS Code 扩展运行在单一 Extension Host 进程中，
// 无需额外加锁。

/**
 * 已读文件状态缓存
 *
 * 全局只需一个实例（per extension host），由 toolsManager 在执行工具前注入到
 * 工具上下文中，避免到处 import 单例。
 */
export class FileStateCache {
  private readonly _entries = new Map<string, FileState>()
  private _bytes = 0

  constructor(
    /** 最大条目数 */
    private readonly _maxEntries: number = DEFAULT_MAX_ENTRIES,
    /** 最大内容字节数（仅统计 FileState.content 长度） */
    private readonly _maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  /**
   * 查询路径的缓存状态。
   * 命中时把条目挪到 LRU 末尾。
   */
  get(filePath: string): FileState | undefined {
    const key = normalizeKey(filePath)
    const state = this._entries.get(key)
    if (!state) return undefined
    // 重新插入以更新 LRU 顺序
    this._entries.delete(key)
    this._entries.set(key, state)
    return state
  }

  /**
   * 写入或更新一条文件状态。
   * 容量超限时淘汰最早条目。
   */
  set(filePath: string, state: FileState): void {
    const key = normalizeKey(filePath)
    const existing = this._entries.get(key)
    if (existing?.content) {
      this._bytes -= byteLength(existing.content)
    }
    this._entries.delete(key)
    this._entries.set(key, state)
    if (state.content) {
      this._bytes += byteLength(state.content)
    }
    this._evictIfNeeded()
  }

  /**
   * 写工具后必须调用：删除指定路径的缓存条目，
   * 防止下一轮 read_file 命中过期的"未修改"分支。
   */
  invalidate(filePath: string): void {
    const key = normalizeKey(filePath)
    const existing = this._entries.get(key)
    if (!existing) return
    if (existing.content) {
      this._bytes -= byteLength(existing.content)
    }
    this._entries.delete(key)
  }

  /** 清空缓存（仅供测试） */
  clear(): void {
    this._entries.clear()
    this._bytes = 0
  }

  /** 当前缓存条目数（仅供诊断与测试） */
  get size(): number {
    return this._entries.size
  }

  /** 当前缓存内容字节总数（仅供诊断与测试） */
  get bytes(): number {
    return this._bytes
  }

  /**
   * 容量超限时按 LRU 顺序剔除最早条目，直到回到上限内
   */
  private _evictIfNeeded(): void {
    while (this._entries.size > this._maxEntries || this._bytes > this._maxBytes) {
      const oldestKey = this._entries.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this._entries.get(oldestKey)
      if (oldest?.content) {
        this._bytes -= byteLength(oldest.content)
      }
      this._entries.delete(oldestKey)
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 归一化路径键
 *
 * 处理：
 *   - 相对/绝对路径混用 → path.resolve
 *   - Windows 大小写不敏感 → toLowerCase（路径段视为同一文件）
 *   - 多余的 . 和 .. → path.normalize
 *   - / 与 \ 分隔符差异 → 统一替换为 path.sep（内置已处理）
 */
function normalizeKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  // Windows 路径默认大小写不敏感；Linux/macOS 保留原样以避免误并
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 字符串字节长度（UTF-8） */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8')
}

// ── 单例导出 ──────────────────────────────────────────────────────────────────

/**
 * 全局唯一实例
 *
 * VS Code 扩展运行在单一 Extension Host 进程中，模块系统保证此实例唯一。
 * 工具执行时由 toolsManager 注入到 ToolExecuteContext.fileState，避免到处
 * import 单例（便于单元测试 stub）。
 */
export const fileStateCache = new FileStateCache()
