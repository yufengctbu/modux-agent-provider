// ─────────────────────────────────────────────────────────────────────────────
// src/config/config.ts — 运行时配置
//
// 修改后重新执行 npm run build 即可生效。
// 不需要的条目可以直接注释掉或改 enabled: false。
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // ── LLM 适配器列表 ─────────────────────────────────────────────────────────
  // 按顺序查找，采用第一个 enabled: true 的条目。
  // type 必须与 provider/adapters/ 下已注册的工厂匹配。
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

  // ── 工具开关 ───────────────────────────────────────────────────────────────
  // 设为 false 可禁用某个工具（LLM 将看不到该工具的描述，无法调用）
  tools: {
    readFile: { enabled: true },
    listDir: { enabled: true },
    findFiles: { enabled: true },
    searchCode: { enabled: true },
    editFile: { enabled: true },
    writeFile: { enabled: true }, // 全量写文件（谨慎开启，会覆盖原文件）
    webFetch: { enabled: true },
    webSearch: { enabled: true },
    lspInfo: { enabled: true },
    todoWrite: { enabled: true },
    askUser: { enabled: true },
    runCommand: { enabled: true, timeoutMs: 10_000 }, // 执行 shell 命令（谨慎开启）
  },

  // ── Agent 行为配置 ─────────────────────────────────────────────────────────
  agent: {
    // 追加到默认 System Prompt 之后的自定义指令（空字符串则不追加）
    systemPrompt: '',

    // 响应语言，如 "Chinese (Simplified)"、"Japanese"；留空时 AI 自行判断
    language: '',

    // Agent Loop 单次任务最大循环轮次（防止无限循环）
    maxLoopRounds: 10,

    // 触发 LLM 历史摘要压缩的消息轮数阈值（初始化时，超过此值才压缩）
    compactThreshold: 10,

    // 摘要失败时的兜底硬截断轮数（建议 >= compactThreshold）
    maxHistoryTurns: 20,

    // 是否启用 LLM 摘要压缩（false 时直接截断至 maxHistoryTurns）
    compactHistoryEnabled: true,

    // read_file 命中相同文件 + 范围 + mtime 时返回缓存 stub（减少重复读）
    fileReadDedupEnabled: true,

    // 单张图像最大字节数，超出则拒绝读取（默认 5 MB）
    maxImageBytes: 5 * 1024 * 1024,

    // 微压缩：是否对历史中"足够老 + 足够大"的工具结果做占位替换
    microcompactEnabled: true,

    // 微压缩：最近多少条 ToolResult 永远不压缩（保留 LLM 的近期工作记忆）
    microcompactKeepRecentToolResults: 6,

    // 微压缩：单条 ToolResult 字符数低于此值时不压缩（收益不足时跳过）
    microcompactMinToolResultChars: 400,

    // 做 LLM 摘要压缩前是否剥离图像 DataPart（文字摘要模型不需要图像）
    stripImagesInCompact: true,
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
    // 每次重试丢弃最旧 20% 历史，三次后约剩 51%
    maxPtlRetries: 3,

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
