import { defineConfig } from 'vite'
import { resolve } from 'path'

// import.meta.dirname 在 Node 20.11+ / 21.2+ 中可用（替代 CJS 的 __dirname）
const __dirname = import.meta.dirname

export default defineConfig({
  build: {
    // 以库模式构建，输出 CJS 格式供 VS Code 扩展加载
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.cjs',
    },
    rollupOptions: {
      // vscode 模块由 VS Code 运行时提供，不打包进产物
      external: ['vscode'],
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
