import type { AgentRunner, TaskRunContext, AgentEvent } from './types'
import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'
import { dispatcherRunner } from './dispatcher-runner'
import { claudeRunner } from './claude-runner'
import { buildAgentContext } from '../agent-context'

/**
 * Wraps a runner so every execution gets ORION snapshot + vector knowledge
 * injected into the system prompt automatically — regardless of which caller
 * invoked the runner (task runner, watcher, etc.).
 *
 * The query used for vector search is the task title + description, which
 * gives semantically relevant notes without the agent needing to ask.
 */
function withContext(runner: AgentRunner): AgentRunner {
  return {
    async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
      const query = [ctx.taskTitle, ctx.taskDescription ?? ''].join(' ').trim()
      const contextBlock = await buildAgentContext(query)
      const enrichedCtx: TaskRunContext = contextBlock
        ? { ...ctx, systemPrompt: ctx.systemPrompt + contextBlock }
        : ctx
      yield* runner.run(enrichedCtx)
    },
  }
}

/**
 * Returns the appropriate runner for a given modelId, pre-wrapped with
 * automatic context injection (ORION snapshot + vector search).
 * claude:* or 'claude' -> claudeRunner (orion-claude sidecar, OAuth — never direct API)
 * ollama:* or ext:* -> dispatcherRunner
 * Default -> openaiRunner (OpenAI-compatible endpoint)
 */
export function createRunner(modelId: string): AgentRunner {
  let base: AgentRunner
  if (modelId.startsWith('claude:') || modelId === 'claude') base = claudeRunner
  else if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) base = dispatcherRunner
  else base = openaiRunner
  return withContext(base)
}

export type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
