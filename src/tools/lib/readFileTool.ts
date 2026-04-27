import * as fs from 'node:fs/promises'
import { config } from '../../config'
import { log } from '../../shared/logger'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  ImageTooLargeError,
  isImageExtension,
  loadImage,
} from '../../shared/imageReader'
import { FILE_UNCHANGED_STUB } from '../../shared/fileStateCache'
import type { ModuxTool, ToolExecuteContext, ToolResult } from '../types'
import { resolveWorkspacePath } from '../utils'

// ***
// 工具：读取工作区文件
//
// 支持模式：
//   - 文本文件：返回带行号（cat -n 格式）的内容片段，最多 2000 行/次
//   - 图像文件：PNG/JPEG/GIF/WebP，作为 LanguageModelDataPart.image() 附件回传
//
// Token 节省策略（对应 Claude Code FileReadTool.ts）：
//   - 文件去重：若同一文件 + 同一行范围且 mtime 未变，返回 FILE_UNCHANGED_STUB
//     占位符，先前的工具结果仍在历史中，避免反复传输全文
//   - 图像大小护栏：超过 maxImageBytes 的图像直接拒绝，避免污染上下文
// ***

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 单次读取最大行数（2000 行） */
const MAX_LINES_TO_READ = 2000

/** 超长文件输出时的截断提示阈值 */
const TRUNCATION_NOTICE_THRESHOLD = MAX_LINES_TO_READ

/** 文件去重 stub 的最大字符数（远小于实际文件，节省截断管线开销） */
const FILE_UNCHANGED_STUB_MAX_CHARS = 1_000

// ── read_file ─────────────────────────────────────────────────────────────────

interface ReadFileInput {
  path: string
  startLine?: number
  endLine?: number
}

export const name = 'read_file'

export const readFileTool: ModuxTool = {
  name,
  description:
    'Read a file from the workspace. ' +
    'For text files: returns content with line numbers (cat -n format) for precise line references. ' +
    'Use startLine/endLine to read a specific range (1-based). Files longer than 2000 lines must be read in sections. ' +
    'For image files (PNG/JPEG/GIF/WebP): the image is attached to the result so vision-capable models can analyze it directly. ' +
    'If the same file + range was already read and has not been modified on disk, returns a brief "unchanged" notice instead of the full content (the original tool result is still in conversation history).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root' },
      startLine: {
        type: 'number',
        description: 'First line to read, 1-based (default: 1). Ignored for image files.',
      },
      endLine: {
        type: 'number',
        description: 'Last line to read, 1-based (default: end of file). Ignored for image files.',
      },
    },
    required: ['path'],
  },
  isReadOnly: true,
  maxResultChars: 20000,

  async execute(input: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
    const { path: filePath, startLine, endLine } = input as ReadFileInput

    const resolved = resolveWorkspacePath(filePath)
    if (typeof resolved === 'object') return { text: resolved.error }

    // ── 图像分支 ──────────────────────────────────────────────────────────────
    // 早判断：图像不走文本读取流程，避免把二进制乱码塞给 LLM
    if (isImageExtension(filePath)) {
      return readImageBranch(resolved, filePath)
    }

    // ── 文本去重快捷路径 ──────────────────────────────────────────────────────
    // 同一文件 + 同一范围 + 同一 mtime → 返回 stub，节省 token
    if (config.agent.fileReadDedupEnabled) {
      const stubResult = await tryReturnUnchangedStub(ctx, resolved, filePath, startLine, endLine)
      if (stubResult) return stubResult
    }

    // ── 文本读取主流程 ────────────────────────────────────────────────────────
    let content: string
    let mtimeMs: number
    try {
      const stat = await fs.stat(resolved)
      mtimeMs = stat.mtimeMs
      content = await fs.readFile(resolved, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { text: `Failed to read file "${filePath}": ${msg}` }
    }

    const allLines = content.split('\n')
    const totalLines = allLines.length

    // 计算实际读取范围（1-based → 0-based index）
    const start = Math.max(1, startLine ?? 1)
    const rawEnd = endLine ?? totalLines
    const end = Math.min(rawEnd, start + MAX_LINES_TO_READ - 1, totalLines)

    const slicedLines = allLines.slice(start - 1, end)
    const lineWidth = String(totalLines).length // 行号对齐宽度

    // cat -n 格式：右对齐行号 + 两个空格 + 内容
    const numbered = slicedLines
      .map((line, i) => `${String(start + i).padStart(lineWidth)}  ${line}`)
      .join('\n')

    // 还有更多行未显示时，追加截断提示
    const suffix =
      end < totalLines && end >= TRUNCATION_NOTICE_THRESHOLD
        ? `\n... [File has ${totalLines} lines total. Showing lines ${start}–${end}. ` +
          `Use startLine/endLine to read the rest.]`
        : ''

    // 写入文件状态缓存，供下一次相同范围读取时去重
    // 注意：缓存"用户请求的范围"（startLine / endLine 原值），而非"实际返回的范围"，
    // 这样 LLM 下次以完全相同的参数再调用 read_file 时才能稳定命中 stub。
    ctx.fileState.set(resolved, {
      timestamp: mtimeMs,
      startLine,
      endLine,
    })

    return { text: numbered + suffix }
  },
}

// ── 内部分支实现 ──────────────────────────────────────────────────────────────

/**
 * 图像读取分支：返回 ImageAttachment + 元数据描述文本
 *
 * - 文本部分给出文件路径、尺寸、字节数等元数据，让非视觉模型也能感知到读了什么
 * - attachments 部分由 loop.ts 转成 LanguageModelDataPart.image()
 * - 图像不进入 fileStateCache（缓存值字段是文本快照，非图像；且图像通常不重读）
 */
async function readImageBranch(resolvedPath: string, displayPath: string): Promise<ToolResult> {
  const maxBytes = config.agent.maxImageBytes ?? DEFAULT_IMAGE_MAX_BYTES

  let image
  try {
    image = await loadImage(resolvedPath, maxBytes)
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      return {
        text:
          `Image "${displayPath}" is too large (${formatBytes(err.sizeBytes)}; limit ${formatBytes(err.maxBytes)}). ` +
          `Skip reading or resize the image first.`,
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    log(`[read_file] 图像读取失败：${displayPath}：${msg}`)
    return { text: `Failed to read image "${displayPath}": ${msg}` }
  }

  const dimText = image.dimensions
    ? `${image.dimensions.width}x${image.dimensions.height}`
    : 'unknown size'
  const text =
    `Image attached: "${displayPath}" (${image.mimeType}, ${dimText}, ${formatBytes(image.sizeBytes)}). ` +
    `Vision-capable models will see the image directly; text-only models will see this metadata only.`

  return {
    text,
    attachments: [{ kind: 'image', data: image.data, mimeType: image.mimeType }],
  }
}

/**
 * 命中"文件未变 + 范围相同"时返回 stub 的快捷路径
 *
 * 仅对纯文本读取生效；图像分支不走此处。
 *
 * 失败时（stat 失败、缓存未命中、范围不同）返回 undefined，让主流程兜底。
 */
async function tryReturnUnchangedStub(
  ctx: ToolExecuteContext,
  resolvedPath: string,
  displayPath: string,
  startLine?: number,
  endLine?: number,
): Promise<ToolResult | undefined> {
  const cached = ctx.fileState.get(resolvedPath)
  if (!cached) return undefined

  let mtimeMs: number
  try {
    const stat = await fs.stat(resolvedPath)
    mtimeMs = stat.mtimeMs
  } catch {
    // stat 失败让主流程报真正的错误
    return undefined
  }

  if (mtimeMs !== cached.timestamp) return undefined
  if (cached.startLine !== startLine) return undefined
  if (cached.endLine !== endLine) return undefined

  log(`[read_file] 命中去重：${displayPath}（mtime 与范围均未变）`)
  return {
    text: `${FILE_UNCHANGED_STUB}\n[file: ${displayPath}]`.slice(0, FILE_UNCHANGED_STUB_MAX_CHARS),
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 友好显示字节数（仅用于文本提示） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
