import * as fs from 'node:fs/promises'

// ─────────────────────────────────────────────────────────────────────────────
// imageReader — 零依赖图像读取工具
//
// 设计目标（参考 Claude Code src/utils/imageResizer.ts 与 imageProcessor.ts）：
//   - 检测文件扩展名是否为支持的图像类型
//   - 读取字节，按 magic bytes 校正 MIME（防止扩展名造假）
//   - 提取原始分辨率（PNG / JPEG / GIF / WebP），用于元数据回传
//   - 大小护栏：超过 maxBytes 直接拒绝，让 LLM 知道为什么读不到
//
// 故意不引入 sharp 等原生依赖：
//   - sharp 自带 ~30 MB 平台二进制，VS Code 扩展打包时严重超过 marketplace 50MB 上限
//   - VS Code Language Model API 通过 LanguageModelDataPart.image() 直接接收原始字节，
//     由底层模型适配器自行决定是否压缩；本层无需越俎代庖
//   - 真实场景下用户主动 read 图像的频率远低于 LLM 的隐式处理；保持轻量更重要
//
// 如果未来确实需要服务端压缩（例如自有后端的视觉模型对图像大小敏感），
// 在 adapters 层做一次按需的延迟压缩即可，不污染本工具层。
// ─────────────────────────────────────────────────────────────────────────────

/** 支持的图像扩展名（小写，不带点） */
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** 支持的图像 MIME 类型 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** 单张图像默认大小上限（5 MB，对应主流 LLM API 5MB base64 输入约束） */
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** 图像分辨率信息（用于元数据展示） */
export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

/** 一张已解码的图像 */
export interface LoadedImage {
  /** 原始字节 */
  readonly data: Buffer
  /** 经 magic bytes 校正后的 MIME */
  readonly mimeType: ImageMimeType
  /** 文件大小（字节） */
  readonly sizeBytes: number
  /** 解析出的原始分辨率（解析失败时为 undefined） */
  readonly dimensions?: ImageDimensions
}

/** 大小超过上限时抛出此错误 */
export class ImageTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Image is too large to load: ${formatBytes(sizeBytes)} exceeds the limit of ${formatBytes(maxBytes)}.`,
    )
    this.name = 'ImageTooLargeError'
  }
}

/**
 * 根据扩展名判断是否为支持的图像类型（不读取文件，纯字符串检查）
 */
export function isImageExtension(filenameOrExt: string): boolean {
  const ext = filenameOrExt.includes('.')
    ? filenameOrExt.slice(filenameOrExt.lastIndexOf('.') + 1).toLowerCase()
    : filenameOrExt.toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

/**
 * 读取图像文件并解析元数据
 *
 * 流程：
 *   1. fs.stat 取文件大小，超过 maxBytes 直接拒绝（避免读入大文件）
 *   2. fs.readFile 整文件读入 Buffer
 *   3. 按 magic bytes 检测真实 MIME（防止 .png 实为 jpeg）
 *   4. 解析分辨率（按 MIME 走对应的格式头，失败时静默降级为 undefined）
 *
 * @throws ImageTooLargeError 文件超过 maxBytes
 * @throws Error             读取失败、格式不识别等其他错误
 */
export async function loadImage(
  absolutePath: string,
  maxBytes: number = DEFAULT_IMAGE_MAX_BYTES,
): Promise<LoadedImage> {
  // ── 大小预检（避免把 GB 级文件全读入内存） ──────────────────────────────
  const stat = await fs.stat(absolutePath)
  if (stat.size > maxBytes) {
    throw new ImageTooLargeError(stat.size, maxBytes)
  }

  const data = await fs.readFile(absolutePath)
  const mimeType = detectImageMimeFromBuffer(data)
  if (!mimeType) {
    throw new Error(
      `File at "${absolutePath}" does not appear to be a supported image format (PNG, JPEG, GIF, or WebP).`,
    )
  }

  const dimensions = parseImageDimensions(data, mimeType)

  return {
    data,
    mimeType,
    sizeBytes: stat.size,
    dimensions,
  }
}

/**
 * 通过 magic bytes 检测图像 MIME 类型
 *
 * 不依赖文件扩展名：扩展名可能造假或被工具改名，文件头才是事实。
 * 检查的字节范围足够小（前 12 字节），任何破损或非图像文件会自然返回 null。
 */
export function detectImageMimeFromBuffer(buffer: Buffer): ImageMimeType | null {
  if (buffer.length < 4) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF: 47 49 46 38 (GIF8)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif'
  }

  // WebP: RIFF....WEBP（前 4 字节是 RIFF，第 8-11 字节是 WEBP）
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }

  return null
}

/**
 * 解析图像分辨率（不解码像素，只看头部元数据）
 *
 * 失败时返回 undefined（损坏文件、未支持的子格式等），由调用侧决定是否
 * 把"未知尺寸"当作错误。这里宁可丢失元数据，也不阻断主流程。
 */
export function parseImageDimensions(
  buffer: Buffer,
  mimeType: ImageMimeType,
): ImageDimensions | undefined {
  try {
    switch (mimeType) {
      case 'image/png':
        return parsePngDimensions(buffer)
      case 'image/jpeg':
        return parseJpegDimensions(buffer)
      case 'image/gif':
        return parseGifDimensions(buffer)
      case 'image/webp':
        return parseWebpDimensions(buffer)
    }
  } catch {
    return undefined
  }
}

/**
 * PNG 分辨率：固定位于 IHDR 块，第 16-23 字节
 *   16-19: width (UInt32BE)
 *   20-23: height (UInt32BE)
 */
function parsePngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 24) return undefined
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

/**
 * JPEG 分辨率：扫描 SOF (Start Of Frame) 标记
 *
 * SOF 标记 = 0xFFC0..0xFFCF（除去 0xFFC4 / 0xFFC8 / 0xFFCC，对应 DHT / JPG / DAC）
 * 标记后跟 2 字节段长度 + 1 字节精度 + 2 字节 height + 2 字节 width
 *
 * 跳过其他段：每个段头 0xFF + 标记 + 2 字节长度（包含长度自身）
 */
function parseJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  // 跳过 SOI (FF D8)
  let offset = 2
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) return undefined
    const marker = buffer[offset + 1]
    // EOI 或 SOS 之后没有 SOF，结束扫描
    if (marker === 0xd9 || marker === 0xda) return undefined

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

    if (isSof) {
      // SOF 段：长度(2) + 精度(1) + height(2) + width(2)
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }

    // 跳过这个段
    const segLength = buffer.readUInt16BE(offset + 2)
    offset += 2 + segLength
  }
  return undefined
}

/**
 * GIF 分辨率：固定位于第 6-9 字节（width/height，UInt16LE）
 */
function parseGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  }
}

/**
 * WebP 分辨率：根据子格式（VP8 / VP8L / VP8X）解析
 *
 * 三种子格式的尺寸字段位置不同；这里只支持最常见的 VP8 / VP8L，
 * VP8X (扩展格式) 失败时返回 undefined（不影响主流程）。
 */
function parseWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30) return undefined
  // 第 12-15 字节是子格式标识：VP8 / VP8L / VP8X
  const sub = buffer.toString('ascii', 12, 16)

  if (sub === 'VP8 ') {
    // VP8 lossy: 26-29 字节是 14-bit width/height（小端，低 14 位）
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (sub === 'VP8L') {
    // VP8L lossless: 21-24 字节包含 14-bit width-1 / 14-bit height-1（小端打包）
    const b0 = buffer[21]
    const b1 = buffer[22]
    const b2 = buffer[23]
    const b3 = buffer[24]
    const widthMinus1 = ((b1 & 0x3f) << 8) | b0
    const heightMinus1 = ((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)
    return {
      width: widthMinus1 + 1,
      height: heightMinus1 + 1,
    }
  }
  // VP8X 扩展格式暂不解析（少见且字段布局复杂）
  return undefined
}

/** 友好显示字节大小（仅用于错误信息） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
