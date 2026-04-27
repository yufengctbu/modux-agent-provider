import type * as vscode from 'vscode'

// ─────────────────────────────────────────────────────────────────────────────
// Token 估算工具 — 按字符 Unicode 类别分权加权
//
// 设计目标：
//   - 零依赖（不引入 tiktoken/gpt-tokenizer，避免 100KB+ 词表 + 模型 tokenizer 不同步问题）
//   - 高性能（单次 <1ms，纯数学运算 + 单次遍历）
//   - 中文友好（CJK 字符独立权重，修正简单 len/4 对中文的 ~60% 低估）
//
// 精度参考：
//   - 纯英文 ±10-15%、纯中文 ±15%、中英混合 ±15-20%
//   - 对 UI 进度条（圆形 token 指示器）足够；不适用于精确计费
//
// 参考来源：
//   - Claude Code roughTokenCountEstimation（bytesPerToken=4, JSON=2, images=2000）
//   - BPE tokenizer 特征：CJK 字符 ≈ 0.5-0.7 token/char，拉丁字母 ≈ 0.25 token/char
// ─────────────────────────────────────────────────────────────────────────────

// ── Unicode 区间常量 ──────────────────────────────────────────────────────────

/** CJK 统一汉字基本区 (U+4E00–U+9FFF) */
const CJK_BASE_START = 0x4e00
const CJK_BASE_END = 0x9fff

/** CJK 扩展 A 区 (U+3400–U+4DBF) */
const CJK_EXT_A_START = 0x3400
const CJK_EXT_A_END = 0x4dbf

/** CJK 扩展 B–G 区 (U+20000–U+2A6DF, U+2A700–U+2EBEF, U+30000–U+323AF)
 *  合并为大区间以简化判断 */
const CJK_EXT_B_START = 0x20000
const CJK_EXT_B_END = 0x2ebef

/** CJK 兼容汉字 (U+F900–U+FAFF) */
const CJK_COMPAT_START = 0xf900
const CJK_COMPAT_END = 0xfaff

/** 日文平假名 (U+3040–U+309F) */
const HIRAGANA_START = 0x3040
const HIRAGANA_END = 0x309f

/** 日文片假名 (U+30A0–U+30FF) */
const KATAKANA_START = 0x30a0
const KATAKANA_END = 0x30ff

/** 韩文音节 (U+AC00–U+D7AF) */
const HANGUL_START = 0xac00
const HANGUL_END = 0xd7af

// ── 分权常量（每字符 ≈ N 个 token）────────────────────────────────────────────

/**
 * token/char 权重表
 *
 * 依据：BPE tokenizer 的字符到 token 映射特性
 * - CJK 汉字：每个字通常是 1-2 个独立 BPE token，取中值 0.6
 * - 拉丁字母：4 个字母 ≈ 1 token，取 0.25
 * - JSON 结构符：{}, [], :, ", 逗号通常是独立 token，取 1.0
 * - jsonMode 下结构符权重上调到 1.15：JSON 密集文本里相邻结构符与
 *   key/value 之间常产生额外的 sub-token 边界（实测 +5–15%）
 */
const WEIGHTS = {
  CJK_BASE: 0.6,
  CJK_EXT: 0.7, // 扩展区生僻字 token 数更高
  HIRAGANA: 0.5,
  KATAKANA: 0.5,
  HANGUL: 0.35, // 韩文组合型，较稀疏
  LATIN: 0.25, // a-z, A-Z
  DIGIT: 0.25,
  JSON_STRUCT: 1.0, // {}[]:," 每个都是独立 token
  JSON_STRUCT_BOOST: 1.15, // jsonMode 下的结构符权重（密集 JSON 略偏高）
  PUNCT: 0.75, // 其他 ASCII 标点
  WHITESPACE: 0.1, // 常与相邻字符合并
  OTHER: 0.5, // 保守默认
} as const

/** JSON 结构字符集（charCode，避免循环内 text[i] 的字符串分配）*/
const JSON_STRUCT_CHAR_CODES = new Set<number>([
  0x7b, // {
  0x7d, // }
  0x5b, // [
  0x5d, // ]
  0x3a, // :
  0x2c, // ,
  0x22, // "
])

/** 图像/文档块固定 token 估算（参考 Claude Code 保守值 2000） */
const IMAGE_TOKEN_ESTIMATE = 2000

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 按字符 Unicode 类别分权估算 token 数
 *
 * 单次遍历字符串，对每个字符按其类别应用不同权重。
 * 时间复杂度 O(n)，空间复杂度 O(1)，典型文本 <1ms。
 *
 * @param text  待估算的纯文本
 * @param options.jsonMode 是否为 JSON 密集文本（提升结构符权重）
 * @returns 估算的 token 数（整数）
 *
 * @example
 * estimateTokenCount('Hello world')                        // ≈ 3
 * estimateTokenCount('你好世界')                            // ≈ 2.4 → 2
 * estimateTokenCount('{"a":1,"b":2}')                      // ≈ 10
 * estimateTokenCount('{"a":1,"b":2}', { jsonMode: true })  // ≈ 11（结构符 BOOST）
 */
export function estimateTokenCount(text: string, options?: { jsonMode?: boolean }): number {
  if (!text) return 0

  let tokens = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)

    // High surrogate — 处理 UTF-16 代理对，取完整码点
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        const fullCode = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
        // 扩展 B+ 区 CJK
        if (fullCode >= CJK_EXT_B_START && fullCode <= CJK_EXT_B_END) {
          tokens += WEIGHTS.CJK_EXT
        } else {
          tokens += WEIGHTS.OTHER
        }
        i++ // skip low surrogate
        continue
      }
    }

    // JSON 结构字符优先判断（高频场景）
    // jsonMode 下用 BOOST 权重，反映 JSON 密集文本里结构符更高的 token 密度
    if (options?.jsonMode && JSON_STRUCT_CHAR_CODES.has(code)) {
      tokens += WEIGHTS.JSON_STRUCT_BOOST
      continue
    }

    // CJK 统一汉字基本区
    if (code >= CJK_BASE_START && code <= CJK_BASE_END) {
      tokens += WEIGHTS.CJK_BASE
      continue
    }

    // CJK 扩展 A 区
    if (code >= CJK_EXT_A_START && code <= CJK_EXT_A_END) {
      tokens += WEIGHTS.CJK_EXT
      continue
    }

    // CJK 兼容汉字
    if (code >= CJK_COMPAT_START && code <= CJK_COMPAT_END) {
      tokens += WEIGHTS.CJK_BASE
      continue
    }

    // 日文假名
    if (
      (code >= HIRAGANA_START && code <= HIRAGANA_END) ||
      (code >= KATAKANA_START && code <= KATAKANA_END)
    ) {
      tokens += WEIGHTS.HIRAGANA
      continue
    }

    // 韩文
    if (code >= HANGUL_START && code <= HANGUL_END) {
      tokens += WEIGHTS.HANGUL
      continue
    }

    // 空格/换行/制表符
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
      tokens += WEIGHTS.WHITESPACE
      continue
    }

    // ASCII 数字 0-9
    if (code >= 0x30 && code <= 0x39) {
      tokens += WEIGHTS.DIGIT
      continue
    }

    // ASCII 大写字母 A-Z
    if (code >= 0x41 && code <= 0x5a) {
      tokens += WEIGHTS.LATIN
      continue
    }

    // ASCII 小写字母 a-z
    if (code >= 0x61 && code <= 0x7a) {
      tokens += WEIGHTS.LATIN
      continue
    }

    // JSON 结构字符（非 jsonMode 时仍给独立权重，但低于 BOOST）
    if (JSON_STRUCT_CHAR_CODES.has(code)) {
      tokens += WEIGHTS.JSON_STRUCT
      continue
    }

    // 其他 ASCII 可打印字符（标点/符号等）
    if (code >= 0x21 && code <= 0x7e) {
      tokens += WEIGHTS.PUNCT
      continue
    }

    // 兜底：其他 Unicode
    tokens += WEIGHTS.OTHER
  }

  return Math.round(tokens)
}

/**
 * 估算一条 LanguageModelChatRequestMessage 的 token 数
 *
 * 遍历 content 数组中的所有 Part，按类型分别估算后求和。
 * 对 ImagePart 使用固定值，避免把 base64 字符当作文本计数。
 *
 * @param msg  VS Code 传入的消息对象
 * @returns 估算的 token 数
 */
export function estimateMessageTokens(msg: vscode.LanguageModelChatRequestMessage): number {
  if (typeof msg.content === 'string') {
    return estimateTokenCount(msg.content)
  }

  if (!Array.isArray(msg.content)) return 0

  let tokens = 0

  for (const part of msg.content) {
    // TextPart / ThinkingPart — 按文本估算
    //   ThinkingPart.value 可为 string | string[]；数组用 '\n' 拼接，
    //   避免相邻片段词粘连导致的 token 边界估算偏低
    if ('value' in part) {
      const v = (part as { value: unknown }).value
      if (typeof v === 'string') {
        tokens += estimateTokenCount(v)
      } else if (Array.isArray(v)) {
        tokens += estimateTokenCount(v.join('\n'))
      }
      continue
    }

    // ImagePart / DataPart — 固定 2000 tokens
    // 避免把 base64 或二进制数据当作文本字符计数（会严重高估）
    if ('data' in part && part.data instanceof Uint8Array) {
      tokens += IMAGE_TOKEN_ESTIMATE
      continue
    }

    // ToolCallPart — 名称 + 参数 JSON（jsonMode 提升 JSON 结构符权重，参数就是 JSON）
    if ('callId' in part && 'name' in part && 'input' in part) {
      const inputStr =
        typeof part.input === 'string'
          ? part.input
          : typeof part.input === 'object' && part.input !== null
            ? JSON.stringify(part.input)
            : ''
      tokens += estimateTokenCount((part as { name: string }).name + '\n' + inputStr, {
        jsonMode: true,
      })
      continue
    }

    // ToolResultPart — 递归遍历子 content
    if ('content' in part && Array.isArray(part.content)) {
      for (const inner of part.content) {
        if ('value' in inner) {
          const v = (inner as { value: unknown }).value
          if (typeof v === 'string') {
            tokens += estimateTokenCount(v)
          } else if (Array.isArray(v)) {
            tokens += estimateTokenCount(v.join('\n'))
          }
        } else if ('data' in inner && inner.data instanceof Uint8Array) {
          tokens += IMAGE_TOKEN_ESTIMATE
        }
      }
      continue
    }

    // 兜底：未识别的 part 类型（VS Code 未来扩展或 IPC 反序列化变形）
    // 用 JSON.stringify 的字节估算，避免静默返回 0 误导 UI 进度条。
    // 注意：截断到 2000 字符，防止异常大的 part 把估算拖慢。
    try {
      const fallback = JSON.stringify(part) ?? ''
      tokens += estimateTokenCount(fallback.length > 2000 ? fallback.slice(0, 2000) : fallback)
    } catch {
      // 包含循环引用等无法序列化的对象，给一个保守常量
      tokens += 50
    }
  }

  return tokens
}

/**
 * 估算工具定义列表的 token 数
 *
 * 每个 tool 的定义包括 description + inputSchema JSON，
 * 在 LLM 请求中作为 tools 数组的一部分计入输入 token 预算。
 *
 * @param tools  工具定义数组
 * @returns 估算的 token 数
 */
export function estimateToolDefinitions(tools: readonly vscode.LanguageModelChatTool[]): number {
  let tokens = 0

  for (const tool of tools) {
    const schemaStr = JSON.stringify(tool.inputSchema ?? {})
    const desc = tool.description ?? ''
    tokens += estimateTokenCount(desc + schemaStr, { jsonMode: true })
  }

  return tokens
}

/**
 * 图片/文档固定 token 估算值
 * 参考 Claude Code 保守公式 (width × height) / 750 ≈ 2000
 */
export { IMAGE_TOKEN_ESTIMATE }
