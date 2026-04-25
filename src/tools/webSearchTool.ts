import * as http from 'node:http'
import * as https from 'node:https'
import * as vscode from 'vscode'
import type { ModuxTool } from './types'

// ***
// 工具：网页搜索
//   - web_search  通过 DuckDuckGo HTML 端点进行无密钥搜索
//
// 对比 web_fetch：
//   web_fetch   — 必须提供完整 URL；适合"已知地址、读文档"
//   web_search  — 只需关键词；适合"不知道去哪查、需要先找资源"
//
// 实现说明：
//   - 使用 DuckDuckGo Lite（https://html.duckduckgo.com/html/）——公开页面，无速率签名
//   - 只解析搜索结果页的 <a class="result__a"> 条目，返回 title + url + snippet
//   - 如需深入阅读某条结果，LLM 应继续调用 web_fetch 传入其中的 URL
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** DuckDuckGo HTML 搜索端点（无需 API key） */
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** 请求超时时间（毫秒） */
const SEARCH_TIMEOUT_MS = 15_000

/** 返回结果最大条数 */
const MAX_RESULTS = 10

/** 工具整体输出最大字符数 */
const MAX_RESULT_CHARS = 8_000

// ── web_search ────────────────────────────────────────────────────────────────

interface WebSearchInput {
  query: string
  maxResults?: number
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export const webSearchTool: ModuxTool = {
  name: 'web_search',
  description:
    'Search the web for real-time information and return a list of result titles, URLs, and snippets. ' +
    'Use this for up-to-date facts, library versions, API changes, or when you need to discover authoritative sources. ' +
    'After searching, call web_fetch with one of the returned URLs to read the full page.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (be specific; include version numbers or dates when relevant)',
      },
      maxResults: {
        type: 'number',
        description: `Maximum number of results to return (default ${MAX_RESULTS}, capped at ${MAX_RESULTS})`,
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  maxResultChars: MAX_RESULT_CHARS,

  async execute(input: unknown, token: vscode.CancellationToken): Promise<string> {
    const { query, maxResults } = input as WebSearchInput
    const limit = Math.min(Math.max(1, maxResults ?? MAX_RESULTS), MAX_RESULTS)

    if (!query || !query.trim()) {
      return 'Search failed: query must not be empty.'
    }

    const searchUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`

    let html: string
    try {
      html = await fetchHtml(searchUrl, token)
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        return 'Search cancelled.'
      }
      const msg = err instanceof Error ? err.message : String(err)
      return `Search failed for "${query}": ${msg}`
    }

    const results = parseDuckDuckGoResults(html).slice(0, limit)

    if (results.length === 0) {
      return `No results for "${query}".`
    }

    const formatted = results
      .map((r, i) => {
        const header = `${i + 1}. ${r.title}`
        const url = `   ${r.url}`
        const snippet = r.snippet ? `   ${r.snippet}` : ''
        return [header, url, snippet].filter(Boolean).join('\n')
      })
      .join('\n\n')

    return `Top ${results.length} result(s) for "${query}":\n\n${formatted}`
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 通过 POST 请求获取 DuckDuckGo HTML 搜索结果页 */
async function fetchHtml(url: string, token: vscode.CancellationToken): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (token.isCancellationRequested) {
      reject(new Error('cancelled'))
      return
    }

    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? https : http

    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: SEARCH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', reject)
      },
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${SEARCH_TIMEOUT_MS}ms`))
    })

    token.onCancellationRequested(() => {
      req.destroy()
      reject(new Error('cancelled'))
    })
  })
}

/**
 * 从 DuckDuckGo HTML 结果页提取 SearchResult 列表。
 *
 * 目标结构（简化后）：
 *   <div class="result">
 *     <a class="result__a" href="...">Title</a>
 *     <a class="result__snippet">Snippet text</a>
 *   </div>
 *
 * DuckDuckGo 返回的 href 经常是重定向包装 `/l/?uddg=<encoded>`，需要解码还原真实 URL。
 */
function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // 匹配每条结果块：<a class="result__a" href="...">...</a>，后面跟着 snippet
  const resultPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>|$)/gi

  let match: RegExpExecArray | null
  while ((match = resultPattern.exec(html)) !== null) {
    const rawHref = match[1]
    const title = stripHtml(match[2]).trim()
    const tailHtml = match[3]

    // 解码 DuckDuckGo 重定向 URL
    const url = decodeDuckDuckGoUrl(rawHref)
    if (!url || !title) continue

    // 从尾部 HTML 中抽取 snippet（通常在 class="result__snippet" 里）
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tailHtml)
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : ''

    results.push({ title, url, snippet })
  }

  return results
}

/**
 * DuckDuckGo 使用 /l/?uddg=<encoded-url> 形式重定向。
 * 抽取并解码 uddg 参数，返回真实目标 URL；
 * 非重定向 URL 直接返回原值。
 */
function decodeDuckDuckGoUrl(href: string): string {
  // 处理协议相对 URL（//html.duckduckgo.com/l/?...）
  const normalized = href.startsWith('//') ? `https:${href}` : href

  try {
    const u = new URL(normalized, 'https://html.duckduckgo.com')
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg') ?? '')
    }
    return u.toString()
  } catch {
    return href
  }
}

/** 剥除 HTML 标签并解码基础实体 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}
