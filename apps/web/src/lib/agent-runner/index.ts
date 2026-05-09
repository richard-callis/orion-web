import type { AgentRunner } from './types'
import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'
import { dispatcherRunner } from './dispatcher-runner'
import { claudeRunner } from './claude-runner'

/**
 * Returns the appropriate runner for a given modelId.
 * claude:* or 'claude' -> claudeRunner (orion-claude sidecar, OAuth — never direct API)
 * ollama:* or ext:* -> dispatcherRunner
 * Default -> openaiRunner (OpenAI-compatible endpoint)
 */
export function createRunner(modelId: string): AgentRunner {
  if (modelId.startsWith('claude:') || modelId === 'claude') return claudeRunner
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return dispatcherRunner
  // Default to OpenAI-compatible runner for unknown/legacy model IDs
  return openaiRunner
}

export type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
