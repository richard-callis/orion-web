import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { ollamaRunner } from './ollama-runner'
import { openaiRunner } from './openai-runner'

/**
 * Dispatcher runner — routes requests to the correct runner based on the modelId or provider.
 *
 * - ollama:* -> ollamaRunner
 * - ext:<id> -> lookup provider in DB and route to:
 *    - openai   -> openaiRunner
 *    - custom   -> openaiRunner (OpenAI-compatible: LM Studio, llama.cpp, vLLM)
 *    - ollama   -> ollamaRunner
 *    - anthropic -> openaiRunner (Anthropic API via OpenAI-compatible endpoint)
 *    - default  -> openaiRunner
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
        // Anthropic API via OpenAI-compatible endpoint
        yield* openaiRunner.run(ctx)
      } else if (model.provider === 'custom') {
        // OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, etc.)
        yield* openaiRunner.run(ctx)
      } else {
        yield { type: 'error', error: `Provider ${model.provider} not supported for external models.` }
      }
    } else if (ctx.modelId.startsWith('ollama:')) {
      yield* ollamaRunner.run(ctx)
    } else if (ctx.modelId.startsWith('claude:') || ctx.modelId === 'claude') {
      // Claude models via OpenAI-compatible endpoint
      yield* openaiRunner.run(ctx)
    } else {
      // Default to OpenAI-compatible runner for unknown/legacy model IDs
      yield* openaiRunner.run(ctx)
    }
  }
}
