import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { claudeRunner } from './claude-runner'
import { ollamaRunner } from './ollama-runner'
import { openaiRunner } from './openai-runner'

/**
 * Dispatcher runner — routes requests to the correct runner based on the modelId or provider.
 *
 * - claude:* or 'claude' -> claudeRunner
 * - ollama:* -> ollamaRunner
 * - ext:<id> -> lookup provider in DB and route to:
 *    - openai   -> openaiRunner
 *    - custom   -> openaiRunner (OpenAI-compatible: LM Studio, llama.cpp, vLLM)
 *    - ollama   -> ollamaRunner
 *    - anthropic -> claudeRunner
 *    - default  -> claudeRunner
 */
export const dispatcherRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    if (ctx.modelId.startsWith('ext:')) {
      const { prisma } = await import('../db')
      const extId = ctx.modelId.slice('ext:'.length)
      const model = await prisma.externalModel.findUnique({ where: { id: extId } })

      if (!model) {
        yield { type: 'error', error: `External model ${extId} not found.` }
        return
      }

      if (model.provider === 'openai') {
        yield* openaiRunner.run(ctx)
      } else if (model.provider === 'ollama') {
        yield* ollamaRunner.run(ctx)
      } else if (model.provider === 'anthropic') {
        // If it's an external anthropic model, it might need a custom runner,
        // but for now we'll try the claudeRunner with its modelId.
        yield* claudeRunner.run(ctx)
      } else if (model.provider === 'custom') {
        // OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, etc.)
        yield* openaiRunner.run(ctx)
      } else {
        yield { type: 'error', error: `Provider ${model.provider} not supported for external models.` }
      }
    } else if (ctx.modelId.startsWith('ollama:')) {
      yield* ollamaRunner.run(ctx)
    } else if (ctx.modelId.startsWith('claude:') || ctx.modelId === 'claude') {
      yield* claudeRunner.run(ctx)
    } else {
      // Default to Claude for unknown/legacy model IDs
      yield* claudeRunner.run(ctx)
    }
  }
}
