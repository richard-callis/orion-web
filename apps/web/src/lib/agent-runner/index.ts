import type { AgentRunner } from './types'
import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'
import { dispatcherRunner } from './dispatcher-runner'

/**
 * Returns the appropriate runner for a given modelId.
 * All runners use the same OpenAI-compatible tool loop pattern for LLM-agnostic tool execution.
 * claude:* or 'claude' -> openaiRunner (Anthropic API via OpenAI-compatible endpoint)
 * ollama:* or ext:* -> dispatcherRunner
 */
export function createRunner(modelId: string): AgentRunner {
  if (modelId.startsWith('claude:') || modelId === 'claude') return openaiRunner
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return dispatcherRunner
  // Default to OpenAI-compatible runner for unknown/legacy model IDs
  return openaiRunner
}

export type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
