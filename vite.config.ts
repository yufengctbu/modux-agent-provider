import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

// import.meta.dirname 在 Node 20.11+ / 21.2+ 中可用（替代 CJS 的 __dirname）
const __dirname = import.meta.dirname

export default defineConfig({
  resolve: {
    // 优先解析 Node.js 的包导出条件，避免加载 browser 变体
    conditions: ['node'],
  },
  build: {
    // 与 VS Code 1.95（Electron 33 / Node 20.x）的运行时对齐
    target: 'node20',
    // 以库模式构建，输出 CJS 格式供 VS Code 扩展加载
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.cjs',
    },
    rollupOptions: {
      // vscode 由运行时提供；同时排除带前缀和不带前缀的所有 Node.js 内置模块
      external: ['vscode', /^node:/, ...builtinModules],
      output: {
        exports: 'named',
      },
    },
    outDir: 'dist',
    sourcemap: true,
    minify: false,
  },
})
