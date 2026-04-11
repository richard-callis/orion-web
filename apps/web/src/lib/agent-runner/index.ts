import type { AgentRunner } from './types'
import { claudeRunner } from './claude-runner'
import { ollamaRunner } from './ollama-runner'
import { dispatcherRunner } from './dispatcher-runner'

/**
 * Returns the appropriate runner for a given modelId.
 * claude:* or 'claude' -> claudeRunner
 * ollama:* or ext:* -> dispatcherRunner
 */
export function createRunner(modelId: string): AgentRunner {
  if (modelId.startsWith('claude:') || modelId === 'claude') return claudeRunner
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return dispatcherRunner
  // Default to Claude for unknown/legacy model IDs
  return claudeRunner
}

export type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
