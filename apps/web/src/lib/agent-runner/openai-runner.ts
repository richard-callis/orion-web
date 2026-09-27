import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { createOpenAIProvider } from './engine/providers/openai'
import { runTask } from './task-loop'

/**
 * OpenAI runner — task runs against /v1/chat/completions (OpenAI, llama.cpp,
 * vLLM and other OpenAI-compatible providers) on the shared engine.
 */
export const openaiRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    const cfg = await resolveOpenAIConfig(ctx.modelId)
    const provider = createOpenAIProvider({
      url: `${cfg.baseUrl}/v1/chat/completions`,
      apiKey: cfg.apiKey,
      model: cfg.modelId,
      stream: false,
      timeoutMs: cfg.timeoutSecs * 1000,
      ...(cfg.maxTokens !== null && { extraBody: { max_tokens: cfg.maxTokens } }),
      httpErrorMessage: (status, body) => `OpenAI ${status}: ${body}`,
    })
    yield* runTask(ctx, provider, { parallel: true })
  },
}

interface OpenAIConfig {
  baseUrl: string
  apiKey: string | undefined
  modelId: string
  timeoutSecs: number
  maxTokens: number | null
}

async function resolveOpenAIConfig(modelId: string): Promise<OpenAIConfig> {
  const { prisma } = await import('../db')

  const model = modelId.startsWith('ext:')
    ? await prisma.externalModel.findUnique({ where: { id: modelId.slice('ext:'.length) } })
    : null

  // ext:openai / ext:custom -> configured endpoint
  if (model && (model.provider === 'openai' || model.provider === 'custom')) {
    return {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey || undefined,
      modelId: model.modelId,
      timeoutSecs: model.timeoutSecs ?? 120,
      maxTokens: model.maxTokens ?? null,
    }
  }

  // ext:anthropic -> Anthropic's OpenAI-compatible endpoint
  if (model && model.provider === 'anthropic') {
    return {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey || process.env.ANTHROPIC_API_KEY || undefined,
      modelId: model.modelId,
      timeoutSecs: model.timeoutSecs ?? 120,
      maxTokens: model.maxTokens ?? null,
    }
  }

  // ollama:* -> local Ollama's OpenAI-compatible endpoint
  if (modelId.startsWith('ollama:')) {
    return {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      apiKey: undefined,
      modelId: modelId.slice('ollama:'.length),
      timeoutSecs: 120,
      maxTokens: 8192,
    }
  }

  // claude:* -> Anthropic's OpenAI-compatible endpoint
  if (modelId.startsWith('claude:')) {
    const modelName = modelId.slice('claude:'.length)
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error(`ANTHROPIC_API_KEY environment variable is not set — cannot call Claude model "${modelName}". Set it in your deployment config.`)
    }
    return { baseUrl: 'https://api.anthropic.com', apiKey, modelId: modelName, timeoutSecs: 120, maxTokens: 8192 }
  }

  throw new Error(`No OpenAI-compatible model configured for ID: ${modelId}`)
}
