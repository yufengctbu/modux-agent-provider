// ─────────────────────────────────────────────────────────────────────────────
// src/config/config.ts — 运行时配置
//
// 修改后重新执行 npm run build 即可生效。
// 不需要的条目可以直接注释掉或改 enabled: false。
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  llms: [
    // ModuxBackend：转发至用户自有的 OpenAI-compatible HTTP 服务
    {
      type: 'moduxBackend' as const,
      enabled: false,
      url: 'http://localhost:3000/v1/chat',
      forwardTools: true,
    },
    // DeepSeek：直连 DeepSeek API
    {
      type: 'deepseek' as const,
      enabled: true,
      apiKey: 'sk-e998f1381b9c4af09204baed38d64b46',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      thinkingMode: true, // 启用 CoT 思考模式（会额外消耗 token，但质量更高）
    },
  ],

  // ── Agent 行为配置 ─────────────────────────────────────────────────────────
  agent: {
    // 追加到默认 System Prompt 之后的自定义指令（空字符串则不追加）
    systemPrompt: '',

    // 响应语言，如 "Chinese (Simplified)"、"Japanese"；留空时 AI 自行判断
    language: '',

    // 摘要失败时的兜底硬截断轮数
    maxHistoryTurns: 20,

    // 是否启用 LLM 摘要压缩（false 时直接截断至 maxHistoryTurns）
    compactHistoryEnabled: true,
  },

  // ── 上下文压缩专用配置 ─────────────────────────────────────────────────────
  // 独立于 agent 行为配置，控制运行时 7 层压缩机制的各项参数。
  compact: {
    // 压缩专用 LLM（建议用较小/低成本的模型做摘要，节省费用）
    // 未配置或注释掉此块时，回退到当前激活的主 Adapter
    llm: {
      type: 'deepseek' as const,
      apiKey: 'sk-e998f1381b9c4af09204baed38d64b46',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      thinkingMode: false, // 摘要任务不需要思考模式
    },

    // LLM 摘要调用超时（ms）；超时后 abort，降级为截断
    timeoutMs: 30_000,

    // PTL 渐进截断重试最大次数（Layer 5）
    // 每次重试丢弃最旧 20% 历史，一次重试后历史约压缩到 80%，通常足以解决上下文溢出。
    // 注：修复 reasoning_content token 估算后，第一次 LLM 压缩尝试成功率大幅提升，
    //     无需保留 3 次重试。降为 1 可将每次 compact 触发的最大 API 调用数从 4 降到 2。
    maxPtlRetries: 1,

    // ── Layer 1：微压缩（每轮都执行，首轮一般 no-op）──────────────────────
    // 是否启用微压缩
    microEnabled: true,

    // 最近多少条 ToolResult 不压缩，保留当前推理工作记忆
    microKeepRecentToolResults: 6,

    // 普通文本 ToolResult 的最小压缩阈值
    microMinToolResultChars: 400,

    // 结构化 payload（如 test.md 中 XML/日志样式）的更低触发阈值
    microStructuredMinChars: 220,

    // ── Layer 3：Token 感知自动压缩 ──────────────────────────────────────────
    // 是否在每轮 LLM 调用前检测 token 预算
    autoEnabled: true,

    // 触发 LLM 摘要的 token 使用比例（达到上下文窗口的 75% 时开始压缩）
    autoThresholdRatio: 0.75,

    // 强制先截断再摘要的 token 比例（达到 92% 时双保险，防 OOM）
    autoHardLimitRatio: 0.92,

    // 熔断阈值：连续 LLM 摘要失败达此值后，当轮只做截断不再调 LLM
    autoMaxFailures: 3,

    // ── Reactive Wrapper：响应式 context 过长重试 ─────────────────────────────
    // 是否在 LLM 返回 context_length_exceeded 时自动压缩并重试
    reactiveEnabled: true,

    // 响应式重试最大次数（每次重试都会先做 PTL 压缩）
    reactiveMaxRetries: 2,
  },
} as const

/** 递归只读类型，确保嵌套字段也不可写 */
export type AppConfig = typeof config
