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

### 2. 开发调试

在 VS Code 中按 **F5**，会打开一个新的「扩展开发宿主」窗口。在该窗口的 Copilot Chat 面板中输入 `@modux-agent` 即可调试。

或者启动监听构建：

```bash
npm run dev
```

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

## 扩展方向

- **斜杠命令**：在 `package.json` 的 `commands` 字段添加 `/explain`、`/fix` 等命令
- **后续问题建议**：在 handler 中调用 `stream.button()` 提供快捷操作
- **自定义图标**：在 `chatParticipants` 中添加 `iconPath` 字段
- **接入外部知识库**：在 handler 中调用自有 API，实现 RAG 增强

---

## License

MIT
