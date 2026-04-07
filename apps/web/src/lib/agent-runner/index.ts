import type { AgentRunner } from './types'
import { claudeRunner } from './claude-runner'
import { ollamaRunner } from './ollama-runner'

/**
 * Returns the appropriate runner for a given modelId.
 * claude:* → Claude Code SDK runner
 * ollama:* | ext:* → Ollama function-calling runner
 */
export function createRunner(modelId: string): AgentRunner {
  if (modelId.startsWith('claude:') || modelId === 'claude') return claudeRunner
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return ollamaRunner
  // Default to Claude for unknown/legacy model IDs
  return claudeRunner
}

export type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
