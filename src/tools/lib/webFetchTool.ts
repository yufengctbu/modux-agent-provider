import * as http from 'node:http'
import * as https from 'node:https'
import * as vscode from 'vscode'
import type { ModuxTool, ToolExecuteContext } from '../types'

// ***
// 工具：网页内容抓取
//   - web_fetch  通过 HTTP/HTTPS 获取指定 URL 的内容并返回纯文本
//
// 实现说明：
//   - 使用 Node 内置的 http/https 模块，无外部依赖
//   - HTML 页面自动剥离标签，返回可读文本
//   - 最多跟随 5 次重定向
//   - 支持取消令牌（用户取消时中止请求）
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 单次抓取内容最大字符数，超出部分截断 */
const MAX_RESPONSE_CHARS = 20_000

/** 请求超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 15_000

/** 最大跟随重定向次数 */
const MAX_REDIRECTS = 5

// ── web_fetch ─────────────────────────────────────────────────────────────────

interface WebFetchInput {
  url: string
}

export const name = 'web_fetch'

export const webFetchTool: ModuxTool = {
  name,
  description:
    'Fetch content from a URL and return it as plain text. HTML pages are automatically converted to readable text (tags stripped). ' +
    'Use this to read documentation, API specs, GitHub raw files, changelogs, or any public web page. ' +
    'Output is limited to 20000 characters.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must start with http:// or https://)',
      },
    },
    required: ['url'],
  },
  isReadOnly: true,
  maxResultChars: MAX_RESPONSE_CHARS,

  async execute(input: unknown, ctx: ToolExecuteContext): Promise<string> {
    const { url } = input as WebFetchInput
    const { token } = ctx

    // 基本 URL 格式校验
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return `Failed: "${url}" is not a valid URL.`
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Failed: only http:// and https:// URLs are supported.`
    }

    try {
      const { body, contentType, statusCode } = await fetchWithRedirect(url, MAX_REDIRECTS, token)

      if (statusCode >= 400) {
        return `Failed: HTTP ${statusCode} from "${url}".`
      }

      // 根据 Content-Type 判断是否需要剥离 HTML 标签
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
      const text = isHtml ? htmlToText(body) : body
      const trimmed = text.trim()

      if (trimmed.length === 0) {
        return `No readable content found at "${url}".`
      }

      if (trimmed.length > MAX_RESPONSE_CHARS) {
        return (
          trimmed.slice(0, MAX_RESPONSE_CHARS) +
          `\n... [Content truncated at ${MAX_RESPONSE_CHARS} characters]`
        )
      }

      return trimmed
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        return `Fetch cancelled.`
      }
      const msg = err instanceof Error ? err.message : String(err)
      return `Failed to fetch "${url}": ${msg}`
    }
  },
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

interface FetchResult {
  body: string
  contentType: string
  statusCode: number
}

/** 执行 HTTP/HTTPS 请求，支持重定向跟随和取消令牌 */
async function fetchWithRedirect(
  url: string,
  remainingRedirects: number,
  token: vscode.CancellationToken,
): Promise<FetchResult> {
  return new Promise<FetchResult>((resolve, reject) => {
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
          'User-Agent': 'Mozilla/5.0 (compatible; modux-agent/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0
        const contentType = res.headers['content-type'] ?? ''

        // 处理 3xx 重定向
        const isRedirect = statusCode >= 300 && statusCode < 400
        if (isRedirect && res.headers.location) {
          if (remainingRedirects <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          // 消耗并丢弃当前响应体，避免 socket 挂起
          res.resume()
          const redirectUrl = new URL(res.headers.location, url).toString()
          fetchWithRedirect(redirectUrl, remainingRedirects - 1, token).then(resolve, reject)
          return
        }

        // 收集响应体
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          resolve({ body, contentType, statusCode })
        })
        res.on('error', reject)
      },
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`))
    })

    // 用户取消时中止请求
    token.onCancellationRequested(() => {
      req.destroy()
      reject(new Error('cancelled'))
    })
  })
}

/** 将 HTML 内容转换为可读纯文本 */
function htmlToText(html: string): string {
  // 移除 <script> 和 <style> 块（含内容）
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')

  // 将块级标签替换为换行（p、div、h1-h6、li、br、tr 等）
  text = text.replace(/<\/?(p|div|h[1-6]|li|br|tr|blockquote|pre)\b[^>]*>/gi, '\n')

  // 剥除剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '')

  // 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // 合并多余空白（保留段落间的单个空行）
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')

  return text.trim()
}
