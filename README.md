# modux-agent-provider

一个基于 **GitHub Copilot Chat Participant API** 的 VS Code 扩展，将 `@modux-agent` 注册为 Copilot Chat 中的自定义 Agent。

---

## 效果预览

在 VS Code 的 Copilot Chat 面板中，输入 `@modux-agent` 即可与该 Agent 交互：

```
> @modux-agent 帮我解释这段代码的作用
```

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
npm install
```

### 2. 本地开发调试（推荐）

#### 2.1 一键启动

在 VS Code 中按 **F5**（或菜单 `运行 → 启动调试`），VS Code 会自动：

1. 触发 `watch` 构建任务 —— 后台启动 `vite build --watch`
2. 等待 Vite 完成首次构建（检测到 `✓ built in` 输出）
3. 打开一个新的 **扩展开发宿主（Extension Development Host）** 窗口

> **注意**：宿主窗口是独立的 VS Code 实例，已加载本扩展。必须在**宿主窗口**中使用 Copilot Chat 与 `@modux-agent` 交互，不是原始窗口。

#### 2.2 与 Agent 交互

在宿主窗口中：

1. 打开 Copilot Chat 面板（侧边栏图标 或 `⌃⌘I` / `Ctrl+Alt+I`）
2. 在输入框输入 `@` 可看到 `modux-agent` 出现在候选列表中
3. 选中后发送消息，响应会流式显示在 Chat 面板

```
@modux-agent 帮我解释这段代码
```

#### 2.3 查看运行日志

扩展的所有运行日志输出在 **Output Channel**：

- 在原始窗口（或宿主窗口）菜单：`查看 → 输出`
- 在右上角下拉列表中选择 `modux-agent`

你会看到类似如下输出：

```
[10:23:01] modux-agent 已激活
[10:23:01] Chat Participant 已注册：modux-agent.modux-agent
[10:23:15] 收到消息：帮我解释这段代码
[10:23:15] 使用模型：gpt-4o
[10:23:16] 响应完成
```

#### 2.4 断点调试（源码级）

由于构建时开启了 Source Map，可以直接在 TypeScript 源文件中打断点：

1. 在 `src/agent/handler.ts` 等文件中点击行号左侧设置断点（红点）
2. 按 **F5** 启动调试
3. 在宿主窗口发送消息，程序会在断点处暂停
4. 在原始窗口的调试工具栏可查看调用栈、变量值等

#### 2.5 修改代码后热重载

Vite watch 模式会自动检测文件变化并重新构建。构建完成后：

- 在宿主窗口按 `⌘R`（macOS）/ `Ctrl+R` 重新加载窗口，新代码即时生效
- **无需重新按 F5**，重载窗口即可

#### 2.6 停止调试

- 在原始窗口点击调试工具栏的 **停止** 按钮（红色方块）
- 或按 `⇧F5`（macOS: `Shift+F5`）

---

### 3. 生产构建

```bash
npm run build
```

产物输出至 `dist/extension.cjs`。

### 4. 打包为 `.vsix`

```bash
npm run package
```

生成 `modux-agent-provider-0.0.1.vsix`。

### 5. 安装到 VS Code

```bash
code --install-extension modux-agent-provider-0.0.1.vsix
```

或者在 VS Code 扩展面板点击 `···` → `从 VSIX 安装`。

---

## 项目结构

```
modux-agent-provider/
├── src/
│   ├── extension.ts        # 扩展激活/注销入口
│   ├── types.ts            # 公共常量与类型
│   └── agent/
│       ├── index.ts        # 注册 Chat Participant
│       └── handler.ts      # 处理用户消息，调用 LLM 并流式响应
├── package.json            # VS Code 扩展清单 + npm 配置
├── vite.config.ts          # Vite 构建配置（输出 CJS）
├── tsconfig.json           # TypeScript 配置
├── eslint.config.mjs       # ESLint 规则
├── .prettierrc             # Prettier 格式化规则
├── PLAN.md                 # 项目设计方案
└── README.md               # 本文件
```

---

## 核心原理

### Chat Participant 注册

在 `package.json` 的 `contributes.chatParticipants` 中声明 Agent：

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "modux-agent.modux-agent",
        "name": "modux-agent",
        "description": "Modux Agent — 你的智能编码助手",
        "isSticky": true
      }
    ]
  }
}
```

- **`id`**：扩展内唯一标识，格式为 `<publisher>.<name>`
- **`name`**：用户在 Chat 中使用的 `@` 名称
- **`isSticky`**：为 `true` 时，用户切换问题后 Agent 保持选中状态

### 消息处理流程

```
用户输入 @modux-agent <message>
    ↓
VS Code 路由至 handler.ts
    ↓
vscode.lm.selectChatModels() 获取 Copilot 模型
    ↓
model.sendRequest() 发送消息
    ↓
stream.markdown() 流式输出响应
```

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

| 命令                   | 说明                   |
| ---------------------- | ---------------------- |
| `npm run dev`          | 监听模式构建           |
| `npm run build`        | 生产构建               |
| `npm run package`      | 构建并打包为 `.vsix`   |
| `npm run lint`         | ESLint 检查            |
| `npm run lint:fix`     | ESLint 自动修复        |
| `npm run format`       | Prettier 格式化        |
| `npm run format:check` | 检查格式化是否符合规范 |

---

## 常见问题排查

| 现象                           | 原因                   | 解决方式                                                         |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------- |
| Chat 中没有 `@modux-agent`     | 扩展未激活             | 确认宿主窗口已打开，查看 Output → modux-agent 是否有"已激活"日志 |
| `@modux-agent` 出现但无响应    | Copilot 未登录或无权限 | 在宿主窗口确认 Copilot 扩展已安装并登录 GitHub 账号              |
| 响应报错"未找到可用的语言模型" | 模型未授权             | 首次调用时 VS Code 会弹出授权弹窗，点击"允许"即可                |
| 修改代码后 Agent 行为未变      | 未重载宿主窗口         | 宿主窗口按 `⌘R` / `Ctrl+R` 重载                                  |
| F5 启动后宿主窗口一闪而过      | 构建报错导致加载失败   | 查看原始窗口"终端"面板中的 Vite 错误信息                         |

---

## 扩展方向

- **斜杠命令**：在 `package.json` 的 `commands` 字段添加 `/explain`、`/fix` 等命令
- **后续问题建议**：在 handler 中调用 `stream.button()` 提供快捷操作
- **自定义图标**：在 `chatParticipants` 中添加 `iconPath` 字段
- **接入外部知识库**：在 handler 中调用自有 API，实现 RAG 增强

---

## License

MIT
