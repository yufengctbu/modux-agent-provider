import * as fs from 'node:fs'
import type { TokenCountOptions, TokenCounter } from '../types'

interface DeepSeekTokenizerJson {
  model?: {
    type?: string
    vocab?: Record<string, number>
    merges?: string[]
  }
  pre_tokenizer?: {
    pretokenizers?: Array<{
      type?: string
      pattern?: { Regex?: string }
    }>
  }
}

const DEFAULT_DEEPSEEK_TOKENIZER_JSON =
  '/Users/admin/Downloads/deepseek_v3_tokenizer/tokenizer.json'
const FALLBACK_SPLIT_PATTERNS = {
  numbers: '\\p{N}{1,3}',
  cjk: '[一-龥぀-ゟ゠-ヿ]+',
  wordsAndPunct:
    '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+',
} as const

function bytesToUnicodeMap(): Map<number, string> {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i)
  for (let i = 161; i <= 172; i++) bs.push(i)
  for (let i = 174; i <= 255; i++) bs.push(i)

  const cs = [...bs]
  let n = 0
  for (let b = 0; b <= 255; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }

  const map = new Map<number, string>()
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCodePoint(cs[i]))
  return map
}

function splitIsolated(text: string, regex: RegExp): string[] {
  if (!text) return []
  regex.lastIndex = 0

  const out: string[] = []
  let last = 0
  for (const match of text.matchAll(regex)) {
    const m = match[0]
    if (!m) continue
    const index = match.index ?? 0
    if (index > last) out.push(text.slice(last, index))
    out.push(m)
    last = index + m.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export class DeepSeekCounter implements TokenCounter {
  readonly type = 'deepseek'
  available = false

  private initialized = false
  private readonly vocab = new Map<string, number>()
  private readonly mergeRanks = new Map<string, number>()
  private readonly byteToUnicode = bytesToUnicodeMap()
  private readonly bpeCountCache = new Map<string, number>()

  private splitNumbers = new RegExp(FALLBACK_SPLIT_PATTERNS.numbers, 'gu')
  private splitCjk = new RegExp(FALLBACK_SPLIT_PATTERNS.cjk, 'gu')
  private splitWordsAndPunct = new RegExp(FALLBACK_SPLIT_PATTERNS.wordsAndPunct, 'gu')

  private init(): void {
    if (this.initialized) return
    this.initialized = true

    const candidates = [
      process.env['DEEPSEEK_TOKENIZER_JSON'],
      DEFAULT_DEEPSEEK_TOKENIZER_JSON,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)

    for (const path of candidates) {
      try {
        if (!fs.existsSync(path)) continue
        const json = JSON.parse(fs.readFileSync(path, 'utf8')) as DeepSeekTokenizerJson
        if (json.model?.type !== 'BPE') continue

        for (const [token, id] of Object.entries(json.model.vocab ?? {})) {
          this.vocab.set(token, id)
        }

        const merges = json.model.merges ?? []
        for (let i = 0; i < merges.length; i++) this.mergeRanks.set(merges[i], i)

        const splitRegexes = (json.pre_tokenizer?.pretokenizers ?? [])
          .filter((x) => x.type === 'Split')
          .map((x) => x.pattern?.Regex)
          .filter((x): x is string => typeof x === 'string')

        if (splitRegexes.length >= 3) {
          this.splitNumbers = new RegExp(splitRegexes[0], 'gu')
          this.splitCjk = new RegExp(splitRegexes[1], 'gu')
          this.splitWordsAndPunct = new RegExp(splitRegexes[2], 'gu')
        }

        this.available = true
        return
      } catch {
        // 尝试下一候选路径
      }
    }
  }

  countText(text: string, _options?: TokenCountOptions): number {
    this.init()
    if (!this.available || !text) return 0

    const segments = this.preTokenize(text)
    let total = 0
    for (const segment of segments) total += this.countSegment(segment)
    return total
  }

  private preTokenize(text: string): string[] {
    const stage1 = splitIsolated(text, this.splitNumbers)
    const stage2: string[] = []
    for (const chunk of stage1) stage2.push(...splitIsolated(chunk, this.splitCjk))

    const stage3: string[] = []
    for (const chunk of stage2) stage3.push(...splitIsolated(chunk, this.splitWordsAndPunct))

    return stage3.filter((x) => x.length > 0)
  }

  private countSegment(segment: string): number {
    const mapped = this.toByteLevel(segment)
    const cached = this.bpeCountCache.get(mapped)
    if (cached !== undefined) return cached

    const tokens = this.bpeEncodeAndCount(mapped)
    if (this.bpeCountCache.size > 20_000) this.bpeCountCache.clear()
    this.bpeCountCache.set(mapped, tokens)
    return tokens
  }

  private toByteLevel(text: string): string {
    const bytes = Buffer.from(text, 'utf8')
    let out = ''
    for (const b of bytes) out += this.byteToUnicode.get(b) ?? String.fromCharCode(b)
    return out
  }

  private bpeEncodeAndCount(token: string): number {
    let word = Array.from(token)
    if (word.length === 0) return 0
    if (word.length === 1) return 1

    while (true) {
      let minRank = Number.POSITIVE_INFINITY
      let bestPair: string | undefined

      for (let i = 0; i < word.length - 1; i++) {
        const pair = `${word[i]} ${word[i + 1]}`
        const rank = this.mergeRanks.get(pair)
        if (rank !== undefined && rank < minRank) {
          minRank = rank
          bestPair = pair
        }
      }

      if (!bestPair) break

      const [first, second] = bestPair.split(' ')
      const merged: string[] = []
      let i = 0
      while (i < word.length) {
        if (i < word.length - 1 && word[i] === first && word[i + 1] === second) {
          merged.push(first + second)
          i += 2
        } else {
          merged.push(word[i])
          i += 1
        }
      }
      word = merged
      if (word.length === 1) break
    }

    let count = 0
    for (const piece of word) {
      count += this.vocab.has(piece) ? 1 : Math.max(1, Array.from(piece).length)
    }
    return count
  }
}
