import type { TokenCountOptions, TokenCounter } from '../types'

const CJK_BASE_START = 0x4e00
const CJK_BASE_END = 0x9fff
const CJK_EXT_A_START = 0x3400
const CJK_EXT_A_END = 0x4dbf
const CJK_EXT_B_START = 0x20000
const CJK_EXT_B_END = 0x2ebef
const CJK_COMPAT_START = 0xf900
const CJK_COMPAT_END = 0xfaff
const HIRAGANA_START = 0x3040
const HIRAGANA_END = 0x309f
const KATAKANA_START = 0x30a0
const KATAKANA_END = 0x30ff
const HANGUL_START = 0xac00
const HANGUL_END = 0xd7af

const WEIGHTS = {
  CJK_BASE: 0.6,
  CJK_EXT: 0.7,
  HIRAGANA: 0.5,
  HANGUL: 0.35,
  LATIN: 0.25,
  DIGIT: 0.25,
  JSON_STRUCT: 1.0,
  JSON_STRUCT_BOOST: 1.15,
  PUNCT: 0.75,
  WHITESPACE: 0.1,
  OTHER: 0.5,
} as const

const JSON_STRUCT_CHAR_CODES = new Set<number>([0x7b, 0x7d, 0x5b, 0x5d, 0x3a, 0x2c, 0x22])

export class GenericCounter implements TokenCounter {
  readonly type = 'generic'
  readonly available = true

  countText(text: string, options?: TokenCountOptions): number {
    if (!text) return 0

    let tokens = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)

      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          const fullCode = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
          tokens +=
            fullCode >= CJK_EXT_B_START && fullCode <= CJK_EXT_B_END
              ? WEIGHTS.CJK_EXT
              : WEIGHTS.OTHER
          i++
          continue
        }
      }

      if (options?.jsonMode && JSON_STRUCT_CHAR_CODES.has(code)) {
        tokens += WEIGHTS.JSON_STRUCT_BOOST
        continue
      }

      if (code >= CJK_BASE_START && code <= CJK_BASE_END) {
        tokens += WEIGHTS.CJK_BASE
        continue
      }
      if (code >= CJK_EXT_A_START && code <= CJK_EXT_A_END) {
        tokens += WEIGHTS.CJK_EXT
        continue
      }
      if (code >= CJK_COMPAT_START && code <= CJK_COMPAT_END) {
        tokens += WEIGHTS.CJK_BASE
        continue
      }
      if (
        (code >= HIRAGANA_START && code <= HIRAGANA_END) ||
        (code >= KATAKANA_START && code <= KATAKANA_END)
      ) {
        tokens += WEIGHTS.HIRAGANA
        continue
      }
      if (code >= HANGUL_START && code <= HANGUL_END) {
        tokens += WEIGHTS.HANGUL
        continue
      }
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
        tokens += WEIGHTS.WHITESPACE
        continue
      }
      if (code >= 0x30 && code <= 0x39) {
        tokens += WEIGHTS.DIGIT
        continue
      }
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        tokens += WEIGHTS.LATIN
        continue
      }
      if (JSON_STRUCT_CHAR_CODES.has(code)) {
        tokens += WEIGHTS.JSON_STRUCT
        continue
      }
      if (code >= 0x21 && code <= 0x7e) {
        tokens += WEIGHTS.PUNCT
        continue
      }

      tokens += WEIGHTS.OTHER
    }

    return Math.round(tokens)
  }
}
