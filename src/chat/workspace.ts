import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { log } from '../shared/logger'

// ─────────────────────────────────────────────────────────────────────────────
// 工作区上下文采集器
//
// 职责：
//   1. 采集 git 元信息（分支、主分支、近期提交、当前状态）
//   2. 加载项目 Memory 文件（AGENTS.md / .modux/memory.md / CLAUDE.md）
//
// 设计来源：Claude Code getGitStatus() + getSystemContext() + getClaudeMds()
// 性能策略：模块级 cachedContext 缓存，扩展生命周期内只采集一次（对应 Claude Code memoize()）
// ─────────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** git status --short 输出的最大字符数，防止大量变更文件撑爆 token */
const MAX_GIT_STATUS_CHARS = 2_000

/** Memory 文件内容的最大字符数 */
const MAX_MEMORY_FILE_CHARS = 4_000

/**
 * Memory 文件搜索优先级（止于第一个存在的文件）
 *
 * AGENTS.md          — 优先（与 GitHub Copilot 约定一致）
 * .modux/memory.md   — 其次（项目专属）
 * CLAUDE.md          — 兼容 Claude Code 项目
 */
const MEMORY_FILE_CANDIDATES = ['AGENTS.md', '.modux/memory.md', 'CLAUDE.md']

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 工作区 git + 环境上下文（注入到每轮对话的 Prompt 层 3） */
export interface WorkspaceContext {
  /** 工作区根目录绝对路径 */
  projectRoot: string
  /** 当前 git 分支名（git rev-parse --abbrev-ref HEAD） */
  gitBranch: string
  /** 远程主分支名，如 main / master（PR 场景必须） */
  gitMainBranch: string
  /** git status --short 输出（截断至 MAX_GIT_STATUS_CHARS） */
  gitStatus: string
  /** 近 5 条 git 提交摘要（git log --oneline -n 5） */
  gitRecentCommits: string
  /** 今天的日期，ISO 格式，如 "2026-04-24" */
  today: string
}

/** 工作区上下文缓存 TTL（2 分钟），过期后自动重新采集 */
const WORKSPACE_CONTEXT_TTL_MS = 2 * 60 * 1000

// ── 模块级缓存 ────────────────────────────────────────────────────────────────

/** 对同一个工作区只采集一次（per-extension-activation），对应 Claude Code memoize() */
let cachedWorkspaceContext: WorkspaceContext | null = null
/** 缓存时间戳（epoch ms），用于 TTL 失效 */
let cachedWorkspaceContextTs = 0
/**
 * In-flight 请求去重：同一时刻只允许一次 git 命令并发采集。
 *
 * 不加这个的话，冷启动 / TTL 过期瞬间多个并发调用都会越过缓存检查、
 * 各自 spawn 4 个 git 子进程（4 × N 个无谓 fork），写缓存时互相覆盖。
 */
let inFlightContext: Promise<WorkspaceContext> | null = null

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 获取工作区上下文（首次调用采集，后续走缓存）
 *
 * 并发执行 4 个 git 命令（Promise.all），总耗时约等于最慢的一个命令。
 * git 命令失败时静默降级（返回空字符串），不影响主流程。
 *
 * 并发安全：通过 inFlightContext 共享 Promise，避免多调用方重复采集。
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  // 缓存命中且未过期
  if (cachedWorkspaceContext && Date.now() - cachedWorkspaceContextTs < WORKSPACE_CONTEXT_TTL_MS) {
    return cachedWorkspaceContext
  }

  // 已有 in-flight 采集任务 → 复用同一个 Promise
  if (inFlightContext) return inFlightContext

  inFlightContext = collectWorkspaceContext().finally(() => {
    inFlightContext = null
  })
  return inFlightContext
}

/** 实际的采集逻辑（私有，避免被并发调用方重复执行）*/
async function collectWorkspaceContext(): Promise<WorkspaceContext> {
  const folders = vscode.workspace.workspaceFolders
  const projectRoot = folders?.[0]?.uri.fsPath ?? process.cwd()

  // 并发采集所有 git 信息
  const [gitBranch, gitMainBranch, gitStatus, gitRecentCommits] = await Promise.all([
    runGitCommand(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    resolveMainBranch(projectRoot),
    runGitCommand(projectRoot, ['status', '--short']).then((s) =>
      s.length > MAX_GIT_STATUS_CHARS
        ? s.slice(0, MAX_GIT_STATUS_CHARS) + '\n... [git status truncated]'
        : s,
    ),
    runGitCommand(projectRoot, ['log', '--oneline', '-n', '3']),
  ])

  cachedWorkspaceContext = {
    projectRoot,
    gitBranch: gitBranch || '(unknown branch)',
    gitMainBranch: gitMainBranch || '(unknown main branch)',
    gitStatus: gitStatus || '(workspace clean)',
    gitRecentCommits: gitRecentCommits || '(no commits)',
    today: new Date().toISOString().slice(0, 10),
  }
  cachedWorkspaceContextTs = Date.now()

  log(`[Workspace] 上下文已采集：分支=${cachedWorkspaceContext.gitBranch}`)
  return cachedWorkspaceContext
}

/**
 * 加载项目 Memory 文件内容
 *
 * 按 MEMORY_FILE_CANDIDATES 优先级查找，返回第一个存在文件的内容。
 * 未找到任何文件时返回 null。
 *
 * @param projectRoot 工作区根目录绝对路径
 */
export async function loadMemoryFile(projectRoot: string): Promise<string | null> {
  for (const candidate of MEMORY_FILE_CANDIDATES) {
    const fullPath = path.join(projectRoot, candidate)
    try {
      const content = await fs.readFile(fullPath, 'utf-8')
      const trimmed = content.trim()
      if (!trimmed) continue

      const truncated =
        trimmed.length > MAX_MEMORY_FILE_CHARS
          ? trimmed.slice(0, MAX_MEMORY_FILE_CHARS) + '\n... [Memory file truncated]'
          : trimmed

      log(`[Workspace] 已加载 Memory 文件：${candidate}`)
      return truncated
    } catch {
      // 文件不存在或无权限，继续尝试下一个
    }
  }
  return null
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

/**
 * 执行 git 命令，返回 stdout 的 trim 结果。
 * 失败时静默返回空字符串（不抛出异常，防止 git 不可用时整个 Agent 崩溃）。
 */
async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * 解析远程主分支名（main / master 等）。
 *
 * 优先尝试 `git symbolic-ref refs/remotes/origin/HEAD`，
 * 失败时回退到检查 main/master 是否存在。
 */
async function resolveMainBranch(cwd: string): Promise<string> {
  // 方法 1：从 origin/HEAD 符号引用解析
  const symRef = await runGitCommand(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (symRef) {
    // 格式：refs/remotes/origin/main → 提取 "main"
    return symRef.split('/').pop() ?? ''
  }

  // 方法 2：检查常见主分支名是否存在
  for (const branch of ['main', 'master', 'trunk']) {
    const exists = await runGitCommand(cwd, ['rev-parse', '--verify', branch])
    if (exists) return branch
  }

  return ''
}
