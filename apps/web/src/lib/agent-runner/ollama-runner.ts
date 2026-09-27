import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { createOllamaProvider } from './engine/providers/ollama'
import { runTask } from './task-loop'

/**
 * Ollama runner — task runs against Ollama's native /api/chat on the shared
 * engine. Tools run one at a time (no parallel batch).
 */
export const ollamaRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    const { baseUrl, timeoutSecs } = await resolveOllamaConfig(ctx.modelId)
    const provider = createOllamaProvider({
      baseUrl,
      model: ctx.modelId.startsWith('ollama:') ? ctx.modelId.slice('ollama:'.length) : ctx.modelId,
      stream: false,
      timeoutMs: timeoutSecs * 1000,
    })
    yield* runTask(ctx, provider, { parallel: false })
  },
}

async function resolveOllamaConfig(modelId: string): Promise<{ baseUrl: string; timeoutSecs: number }> {
  // Lazy import prisma to avoid circular deps at module load time
  const { prisma } = await import('../db')

  let model = null
  if (modelId.startsWith('ext:')) {
    model = await prisma.externalModel.findUnique({ where: { id: modelId.slice('ext:'.length) } })
  } else if (modelId.startsWith('ollama:')) {
    model = await prisma.externalModel.findFirst({
      where: { provider: 'ollama', modelId: modelId.slice('ollama:'.length), enabled: true },
    })
  }
  if (!model) {
    model = await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
  }

  if (!model?.baseUrl) throw new Error('No Ollama model configured — add one in Admin → Models')
  return { baseUrl: model.baseUrl, timeoutSecs: model.timeoutSecs ?? 120 }
}
