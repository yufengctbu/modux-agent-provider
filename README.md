# modux-agent-provider

一个基于 **VS Code Language Model Provider API** 的扩展，将自定义 LLM（DeepSeek 或自有后端）注册为 Copilot Chat 的可选模型，出现在模型下拉列表中。

---

## 效果预览

在 VS Code 的 Copilot Chat 面板中，点击模型下拉框，选择 `modux-agent-deepseek`（或你配置的任意名称）即可使用：

```
Copilot Chat 模型下拉 → modux-agent-deepseek
```

选中后，所有 Copilot Chat 请求（含工具调用、多轮对话）均通过本扩展转发至配置的 LLM 后端。

---

## 前置要求

| 工具                | 版本要求     |
| ------------------- | ------------ |
| Node.js             | >= 18        |
| VS Code             | >= 1.95      |
| GitHub Copilot 扩展 | 已安装并登录 |

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置 LLM

编辑 `src/config/config.ts`，在 `llms` 数组中启用所需后端：

```typescript
// 直连 DeepSeek API
{
  type: 'deepseek',
  enabled: true,
  apiKey: 'sk-xxxxxxxxxxxxxxxx',
  model: 'deepseek-v3',
  baseUrl: 'https://api.deepseek.com',
  thinkingMode: false,
},

// 或转发至自有 OpenAI-compatible HTTP 服务
{
  type: 'moduxBackend',
  enabled: true,
  url: 'http://localhost:3000/v1/chat',
  forwardTools: true,
},
```

只有第一个 `enabled: true` 的条目会生效。

### 3. 本地开发调试（推荐）

#### 3.1 一键启动

在 VS Code 中按 **F5**（或菜单 `运行 → 启动调试`），VS Code 会自动：

1. 触发 `watch` 构建任务 —— 后台启动 `vite build --watch`
2. 等待 Vite 完成首次构建（检测到 `✓ built in` 输出）
3. 打开一个新的 **扩展开发宿主（Extension Development Host）** 窗口

> **注意**：宿主窗口是独立的 VS Code 实例，已加载本扩展。必须在**宿主窗口**中使用 Copilot Chat，不是原始窗口。

#### 3.2 选择模型并交互

在宿主窗口中：

1. 打开 Copilot Chat 面板（侧边栏图标 或 `⌃⌘I` / `Ctrl+Alt+I`）
2. 点击输入框旁的**模型下拉框**
3. 选择 `modux-agent-deepseek`（或你配置的模型名）
4. 正常发送消息，响应会流式显示在 Chat 面板

#### 3.3 查看运行日志

- 菜单：`查看 → 输出`
- 右上角下拉列表中选择 `modux-agent`

你会看到类似如下输出：

```
[10:23:01] modux-agent 已激活
[10:23:01] LM Provider 已注册：vendor=modux
[10:23:15] [LM Provider] 请求：model=modux-agent-deepseek，原始消息=3，重建后=6，工具=62，adapter=deepseek
[10:23:15] [Compact] token ≈ 26,400 / 32,000
[10:23:16] 响应完成
```

#### 3.4 断点调试（源码级）

由于构建时开启了 Source Map，可以直接在 TypeScript 源文件中打断点：

1. 在 `src/provider/LmProvider.ts` 等文件中点击行号左侧设置断点（红点）
2. 按 **F5** 启动调试
3. 在宿主窗口发送消息，程序会在断点处暂停

#### 3.5 修改代码后热重载

Vite watch 模式会自动检测文件变化并重新构建。构建完成后：

- 在宿主窗口按 `⌘R`（macOS）/ `Ctrl+R` 重新加载窗口，新代码即时生效
- **无需重新按 F5**，重载窗口即可

#### 3.6 停止调试

- 在原始窗口点击调试工具栏的 **停止** 按钮（红色方块）
- 或按 `⇧F5`（macOS: `Shift+F5`）

---

### 4. 生产构建

```bash
pnpm run build
```

产物输出至 `dist/extension.cjs`。

### 5. 打包为 `.vsix`

```bash
pnpm run package
```

生成 `modux-agent-provider-0.0.1.vsix`。

### 6. 安装到 VS Code

```bash
code --install-extension modux-agent-provider-0.0.1.vsix
```

或者在 VS Code 扩展面板点击 `···` → `从 VSIX 安装`。

---

## 配置说明

所有配置集中在 `src/config/config.ts`，修改后重新构建即可生效。

### `llms[]` — LLM 适配器列表

按顺序查找，采用第一个 `enabled: true` 的条目。

| 字段           | 类型    | 说明                                     |
| -------------- | ------- | ---------------------------------------- |
| `type`         | string  | 适配器类型：`deepseek` \| `moduxBackend` |
| `enabled`      | boolean | 是否激活此后端                           |
| `apiKey`       | string  | DeepSeek API Key（仅 deepseek 类型需要） |
| `model`        | string  | 模型名称，显示在 Copilot Chat 下拉框     |
| `baseUrl`      | string  | API 基础地址                             |
| `thinkingMode` | boolean | 启用 CoT 思考模式（消耗更多 token）      |
| `url`          | string  | 自有后端地址（仅 moduxBackend 类型需要） |
| `forwardTools` | boolean | 是否把工具定义转发给自有后端             |

### `agent` — 行为配置

| 字段                    | 默认值 | 说明                                                  |
| ----------------------- | ------ | ----------------------------------------------------- |
| `systemPrompt`          | `''`   | 追加到默认 System Prompt 之后的自定义指令             |
| `language`              | `''`   | 强制响应语言（如 `"Chinese (Simplified)"`），留空自动 |
| `maxHistoryTurns`       | `20`   | 摘要失败时的兜底硬截断轮数                            |
| `compactHistoryEnabled` | `true` | 是否启用 LLM 摘要压缩（false 时直接截断）             |

### `compact` — 上下文压缩参数

| 字段                 | 默认值  | 说明                                                     |
| -------------------- | ------- | -------------------------------------------------------- |
| `llm`                | —       | 压缩专用 LLM（建议用较小模型节省费用，不配置则用主 LLM） |
| `timeoutMs`          | `30000` | 摘要调用超时（ms），超时后降级为截断                     |
| `maxPtlRetries`      | `1`     | 渐进截断重试最大次数                                     |
| `autoEnabled`        | `true`  | 是否在每轮调用前检测 token 预算                          |
| `autoThresholdRatio` | `0.75`  | 触发 LLM 摘要的 token 比例（上下文窗口的 75%）           |
| `autoHardLimitRatio` | `0.92`  | 强制先截断再摘要的 token 比例（92%，防 OOM）             |
| `autoMaxFailures`    | `3`     | 连续摘要失败次数达此值后，本轮只截断不调 LLM（熔断）     |
| `reactiveEnabled`    | `true`  | 是否在 LLM 返回 context_too_long 时自动压缩并重试        |
| `reactiveMaxRetries` | `2`     | 响应式重试最大次数                                       |

---

## 项目结构

```
modux-agent-provider/
├── src/
│   ├── extension.ts                  # 扩展激活/注销入口
│   │
│   ├── provider/
│   │   ├── index.ts                  # 注册 LM Provider（vscode.lm.registerLanguageModelChatProvider）
│   │   ├── LmProvider.ts             # 核心：消息重建 + 压缩 + 转发
│   │   ├── registry.ts               # Adapter 注册中心（主 Adapter + 压缩专用 Adapter）
│   │   ├── types.ts                  # LlmAdapter 接口定义
│   │   └── adapters/
│   │       ├── index.ts              # Adapter 工厂注册表
│   │       ├── deepseek.ts           # DeepSeek API 适配器
│   │       └── moduxBackend.ts       # 自有后端 HTTP 适配器
│   │
│   ├── chat/
│   │   └── workspace.ts              # 工作区上下文采集（git 状态、项目路径、memory 文件）
│   │
│   ├── compact/                      # 多层上下文压缩机制
│   │   ├── CompactManager.ts         # 压缩调度器（Layer 3 自动压缩 + 响应式重试）
│   │   ├── types.ts                  # 压缩相关类型定义
│   │   ├── utils.ts                  # 工具函数
│   │   └── layers/
│   │       ├── autoCompact.ts        # Layer 3：token 感知自动压缩决策
│   │       ├── micro.ts              # Layer 1：旧工具结果微压缩（占位替换）
│   │       ├── reactive.ts           # 响应式：context_too_long 重试
│   │       ├── retry.ts              # Layer 5：PTL 渐进截断重试
│   │       ├── stripImages.ts        # Layer 2：摘要前剥离图像
│   │       ├── summary.ts            # Layer 4：LLM 摘要
│   │       └── truncate.ts           # 截断工具函数
│   │
│   ├── config/
│   │   └── config.ts                 # 运行时配置（LLM 后端、压缩参数等）
│   │
│   ├── constants/
│   │   └── prompts.ts                # System Prompt 构建（对齐 VS Code 系统工具）
│   │
│   └── shared/
│       ├── logger.ts                 # 日志工具（Output Channel）
│       └── tokenEstimator.ts         # Token 估算工具（零依赖，中英混合友好）
│
├── .vscode/
│   ├── launch.json                   # F5 调试启动配置
│   ├── tasks.json                    # Vite watch 构建任务
│   └── extensions.json               # 推荐安装的扩展
│
├── package.json                      # VS Code 扩展清单 + npm 配置
├── vite.config.ts                    # Vite 构建配置（输出 CJS）
├── tsconfig.json                     # TypeScript 配置
└── README.md                         # 本文件
```

---

## 核心原理

### LM Provider 注册

在 `package.json` 的 `contributes.languageModelChatProviders` 中声明：

```json
{
  "contributes": {
    "languageModelChatProviders": [
      {
        "vendor": "modux",
        "name": "Modux Agent",
        "description": "自定义 LLM 后端（DeepSeek / 自有服务）"
      }
    ]
  }
}
```

通过 `vscode.lm.registerLanguageModelChatProvider('modux', new LmProvider())` 注册。
注册后，Copilot Chat 下拉框中出现以 `modux` 为 vendor 的模型条目。

### 消息处理流程

```
用户在 Copilot Chat 选择 modux 模型 → 发送消息
    ↓
VS Code 调用 LmProvider.provideLanguageModelChatResponse()
    ↓
跳过 messages[0]（Copilot 注入的 32-43K token 系统消息）
    ↓
注入我们自己的 system prompt（~2K token）+ 工作区上下文（git 状态等）
    ↓
CompactManager.applyAutoCompact()（token 预算检查 + 必要时 LLM 摘要）
    ↓
CompactManager.wrapChat() → adapter.chat()（转发给 DeepSeek 或自有后端）
    ↓
流式返回 LanguageModelResponsePart（文字 / 工具调用 / 思考内容）
    ↓
VS Code 执行工具 → 再次调用 provideLanguageModelChatResponse（下一轮）
```

### 工具调用

工具（`options.tools`）由 VS Code/Copilot 提供（约 60 个系统工具），直接透传给后端 LLM，**不需要在扩展内自行实现**。工具执行由 VS Code 负责，扩展只负责转发工具调用结果。

### 上下文压缩

每次 `provideLanguageModelChatResponse` 被调用时，在转发前执行：

1. **工具 token 补偿**：将 60+ 工具定义的约 25K token 纳入预算（这部分独立于 messages，但会占用上下文窗口）
2. **Layer 3 自动压缩**：token 达到上下文窗口 75% 时，触发 LLM 对历史消息做摘要压缩
3. **响应式兜底**：LLM 返回 context_too_long 错误时，自动压缩并重试

### Vite 构建配置要点

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    lib: {
      entry: 'src/extension.ts',
      formats: ['cjs'], // VS Code 扩展必须是 CJS 格式
      fileName: () => 'extension.cjs',
    },
    rollupOptions: {
      external: ['vscode'], // vscode 模块由运行时提供，不打包
    },
  },
})
```

---

## 开发脚本

| 命令                    | 说明                   |
| ----------------------- | ---------------------- |
| `pnpm run dev`          | 监听模式构建           |
| `pnpm run build`        | 生产构建               |
| `pnpm run package`      | 构建并打包为 `.vsix`   |
| `pnpm run lint`         | ESLint 检查            |
| `pnpm run lint:fix`     | ESLint 自动修复        |
| `pnpm run format`       | Prettier 格式化        |
| `pnpm run format:check` | 检查格式化是否符合规范 |

---

## 常见问题排查

| 现象                            | 原因                          | 解决方式                                                                 |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| 下拉框中没有 modux 模型         | 扩展未激活                    | 确认宿主窗口已打开，查看 Output → modux-agent 是否有"已激活"日志         |
| 选中模型后发送无响应            | Adapter 未配置或 API Key 错误 | 检查 config.ts 中 `llms` 是否有 `enabled: true` 条目，及 apiKey 是否正确 |
| 响应报错"未启用任何 LLM 适配器" | 所有 llms 条目均为 false      | 将至少一个条目的 `enabled` 改为 `true`，重新构建                         |
| 修改代码后行为未变              | 未重载宿主窗口                | 宿主窗口按 `⌘R` / `Ctrl+R` 重载                                          |
| F5 启动后宿主窗口一闪而过       | 构建报错导致加载失败          | 查看原始窗口"终端"面板中的 Vite 错误信息                                 |

---

## License

MIT
