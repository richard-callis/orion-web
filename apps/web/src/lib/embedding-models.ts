/**
 * Embedding models are stored beside chat models (ExternalModel has no kind), so
 * they are told apart by name. They can't chat: nothing falls back to one, none can be
 * made a default, and a default that already is one counts as unset. Where one was
 * chosen (a chat, an agent) it is refused, never replaced: the replacement could send a
 * local conversation to a cloud model.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './db'

const CONTAINS = ['embed', 'minilm', 'paraphrase-multilingual']
/** At the start of the id, or of its last part (`BAAI/bge-m3`, `hf.co/org/bge-m3-GGUF`). */
const PREFIXES = ['bge-', 'gte-', 'e5-', 'multilingual-e5']

export function isEmbeddingModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return CONTAINS.some(s => id.includes(s)) || PREFIXES.some(p => id.startsWith(p) || id.includes(`/${p}`))
}

/** Prisma filter with the same rules, for models that can chat. Spread into a `where`. */
export const CHAT_MODELS = {
  NOT: {
    OR: [
      ...[...CONTAINS, ...PREFIXES.map(p => `/${p}`)].map(contains => ({ modelId: { contains, mode: 'insensitive' as const } })),
      ...PREFIXES.map(startsWith => ({ modelId: { startsWith, mode: 'insensitive' as const } })),
    ],
  },
} satisfies Prisma.ExternalModelWhereInput

export const EMBEDDING_MODEL_ERROR = "is an embedding model and can't chat; choose another model"

/** Does a model choice (`ext:<id>`, a bare ExternalModel id, or an Ollama name) name an embedding model? */
export async function refersToEmbeddingModel(ref: string): Promise<boolean> {
  if (/^(claude|gemini|ollama)(:|$)/.test(ref)) return ref.startsWith('ollama:') && isEmbeddingModel(ref.slice('ollama:'.length))
  const row = await prisma.externalModel.findUnique({ where: { id: ref.replace(/^ext:/, '') }, select: { modelId: true } })
  return isEmbeddingModel(row ? row.modelId : ref.startsWith('ext:') ? '' : ref)
}

/** A stored default, or undefined when there is none or it can't chat. */
export async function chatModelChoice(value: unknown, source: string): Promise<string | undefined> {
  if (typeof value !== 'string' || !value) return undefined
  if (!(await refersToEmbeddingModel(value))) return value
  console.warn(`[models] ${source} names an embedding model (${value}), which can't chat — ignored`)
  return undefined
}

const DEFAULT_SETTINGS = ['model.default', 'ai.default-model', 'dream.model']

/** Is this an attempt to store an embedding model as a default chat model? */
export async function isRefusedDefault(key: string, value: unknown): Promise<boolean> {
  return DEFAULT_SETTINGS.includes(key) && typeof value === 'string' && value !== '' && refersToEmbeddingModel(value)
}
