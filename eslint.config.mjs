// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 禁止未使用的变量（以 _ 开头的除外）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 禁止显式 any，保持类型安全
      '@typescript-eslint/no-explicit-any': 'warn',
      // 一致使用 const
      'prefer-const': 'error',
    },
  },
  {
    // 忽略构建产物
    ignores: ['dist/**', 'node_modules/**'],
  },
)
