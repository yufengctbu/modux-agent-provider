// ─────────────────────────────────────────────────────────────────────────────
// VS Code Proposed API: languageModelThinkingPart
//
// 仓库源：microsoft/vscode src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts
// 拷贝时间：2026-04，version: 1
//
// 用途：通过 LanguageModelThinkingPart 把模型的"思考/推理"内容流式回传给 VS Code
// Chat / Cursor，UI 自动渲染为"正在推理"那种带状态点的灰色折叠条。
//
// 启用方式：package.json 中需声明
//   "enabledApiProposals": ["languageModelThinkingPart"]
//
// 兼容策略：本扩展运行时通过 'LanguageModelThinkingPart' in vscode 做存在性检测，
// 不可用时优雅降级为不渲染思考块（reasoning 仍走内存缓存维持多轮一致性）。
// ─────────────────────────────────────────────────────────────────────────────

declare module 'vscode' {
  /**
   * A language model response part containing thinking/reasoning content.
   * Thinking tokens represent the model's internal reasoning process that
   * typically streams before the final response.
   */
  export class LanguageModelThinkingPart {
    /** The thinking/reasoning text content. */
    value: string | string[]

    /**
     * Optional unique identifier for this thinking sequence.
     * Typically provided at the end of the thinking stream.
     */
    id?: string

    /** Optional metadata associated with this thinking sequence. */
    metadata?: { readonly [key: string]: unknown }

    constructor(
      value: string | string[],
      id?: string,
      metadata?: { readonly [key: string]: unknown },
    )
  }
}
