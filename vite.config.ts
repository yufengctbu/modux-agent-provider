import { defineConfig } from 'vite'
import { resolve } from 'path'

// import.meta.dirname 在 Node 20.11+ / 21.2+ 中可用（替代 CJS 的 __dirname）
const __dirname = import.meta.dirname

/** VS Code 扩展依赖的 Node.js 内置模块，运行时由宿主提供，不打包进产物 */
const NODE_BUILTINS = [
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:child_process',
  'node:util',
  'node:os',
  'node:crypto',
  'fs',
  'fs/promises',
  'path',
  'child_process',
  'util',
  'os',
  'crypto',
]

export default defineConfig({
  build: {
    // 以库模式构建，输出 CJS 格式供 VS Code 扩展加载
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.cjs',
    },
    rollupOptions: {
      // vscode 模块及所有 Node.js 内置模块由运行时提供，不打包
      external: ['vscode', ...NODE_BUILTINS],
      output: {
        exports: 'named',
      },
    },
    outDir: 'dist',
    sourcemap: true,
    // 保持可读性，便于调试
    minify: false,
  },
})
