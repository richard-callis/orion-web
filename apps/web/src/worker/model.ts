import { prisma } from '@/lib/db'

let cachedDefaultModel: string | null = null
let cachedDefaultModelAt = 0
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000 // re-read from DB every 5 minutes

/**
 * Resolve an agent's LLM setting to a concrete model ID.
 *
 * Rules:
 * - falsy / boolean true → use system default (SystemSetting['model.default'])
 * - bare agent ID (no prefix) → treat as ext:<id>
 * - already prefixed (claude:*, ollama:*, ext:*) → use as-is
 *
 * Falls back to 'claude:claude-sonnet-4-6' only if no system default is set.
 */
export async function resolveModelId(llm: unknown): Promise<string> {
  const useDefault = !llm || llm === true

  if (useDefault || typeof llm !== 'string') {
    if (!cachedDefaultModel || Date.now() - cachedDefaultModelAt > MODEL_CACHE_TTL_MS) {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'model.default' } })
      const value = setting?.value as string | undefined
      if (!value) throw new Error('No default LLM configured — set model.default in System Settings')
      cachedDefaultModel = value
      cachedDefaultModelAt = Date.now()
    }
    return cachedDefaultModel
  }

  // Bare agent/model ID with no routing prefix → treat as external gateway agent
  if (!llm.startsWith('claude:') && !llm.startsWith('ollama:') && !llm.startsWith('ext:')) {
    return `ext:${llm}`
  }

  return llm
}
