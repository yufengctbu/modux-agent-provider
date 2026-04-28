import type * as vscode from 'vscode'
import { DeepSeekCounter } from './counters/deepseekCounter'
import { GenericCounter } from './counters/genericCounter'
import type { TokenCountOptions, TokenCounter, TokenManagerLike } from './types'

export const IMAGE_TOKEN_ESTIMATE = 2000

class TokenManager implements TokenManagerLike {
  private readonly genericCounter = new GenericCounter()
  private readonly counters = new Map<string, TokenCounter>()

  constructor() {
    this.counters.set(this.genericCounter.type, this.genericCounter)
    const deepseek = new DeepSeekCounter()
    this.counters.set(deepseek.type, deepseek)
  }

  private resolveCounter(llmType: string | undefined): TokenCounter {
    const key = (llmType ?? '').toLowerCase()
    const counter = this.counters.get(key)
    if (!counter) return this.genericCounter
    if (!counter.available) return this.genericCounter
    return counter
  }

  countText(llmType: string | undefined, text: string, options?: TokenCountOptions): number {
    if (!text) return 0
    const counter = this.resolveCounter(llmType)
    return counter.countText(text, options)
  }

  countMessage(llmType: string | undefined, msg: vscode.LanguageModelChatRequestMessage): number {
    if (typeof msg.content === 'string') {
      return this.countText(llmType, msg.content)
    }

    if (!Array.isArray(msg.content)) return 0

    let tokens = 0

    for (const part of msg.content) {
      if ('value' in part) {
        const v = (part as { value: unknown }).value
        if (typeof v === 'string') {
          tokens += this.countText(llmType, v)
        } else if (Array.isArray(v)) {
          tokens += this.countText(llmType, v.join('\n'))
        }
        continue
      }

      if ('data' in part && part.data instanceof Uint8Array) {
        tokens += IMAGE_TOKEN_ESTIMATE
        continue
      }

      if ('callId' in part && 'name' in part && 'input' in part) {
        const inputStr =
          typeof part.input === 'string'
            ? part.input
            : typeof part.input === 'object' && part.input !== null
              ? JSON.stringify(part.input)
              : ''
        tokens += this.countText(llmType, (part as { name: string }).name + '\n' + inputStr, {
          jsonMode: true,
        })
        continue
      }

      if ('content' in part && Array.isArray(part.content)) {
        for (const inner of part.content) {
          if ('value' in inner) {
            const v = (inner as { value: unknown }).value
            if (typeof v === 'string') {
              tokens += this.countText(llmType, v)
            } else if (Array.isArray(v)) {
              tokens += this.countText(llmType, v.join('\n'))
            }
          } else if ('data' in inner && inner.data instanceof Uint8Array) {
            tokens += IMAGE_TOKEN_ESTIMATE
          }
        }
        continue
      }

      try {
        const fallback = JSON.stringify(part) ?? ''
        const short = fallback.length > 2000 ? fallback.slice(0, 2000) : fallback
        tokens += this.countText(llmType, short)
      } catch {
        tokens += 50
      }
    }

    return tokens
  }

  countMessages(
    llmType: string | undefined,
    messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
  ): number {
    let total = 0
    for (const msg of messages) {
      total += this.countMessage(llmType, msg as vscode.LanguageModelChatRequestMessage)
    }
    return total
  }
}

const tokenManager = new TokenManager()

export function getTokenManager(): TokenManagerLike {
  return tokenManager
}

export function countTokensByType(
  llmType: string | undefined,
  text: string,
  options?: TokenCountOptions,
): number {
  return tokenManager.countText(llmType, text, options)
}
