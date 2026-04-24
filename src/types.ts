/** Chat Participant 的唯一标识符，需与 package.json contributes.chatParticipants[].id 一致 */
export const AGENT_ID = 'modux-agent.modux-agent'

/** 在 Copilot Chat 中显示的 @ 名称 */
export const AGENT_NAME = 'modux-agent'

/** 当没有可用模型时的回退提示 */
export const NO_MODEL_MESSAGE =
  '未找到可用的语言模型。请确保已安装并启用 GitHub Copilot 扩展。'
