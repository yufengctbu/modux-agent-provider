import rawConfig from './config.json'

/**
 * 运行时配置入口
 *
 * 使用方式：
 *   import { config } from '../config'
 *   config.backend.enabled   // boolean
 *   config.backend.url       // string
 *   config.llm.vendor        // string
 *   config.llm.family        // string
 *
 * 修改配置：直接编辑 src/config/config.json，然后重新执行 npm run build
 * 注意：此文件只导出只读对象，所有字段在 TypeScript 层面均不可写入
 *
 * 字段说明：
 *   backend.enabled  是否将聊天请求转发到自定义后端服务
 *   backend.url      后端接口地址
 *   llm.vendor       底层 Copilot 模型提供方（固定为 "copilot"）
 *   llm.family       底层模型系列，可改为 "gpt-4o-mini" / "claude-sonnet-4-5" 等
 */

/** 递归只读类型，确保嵌套字段也不可写 */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

export const config: DeepReadonly<typeof rawConfig> = rawConfig
