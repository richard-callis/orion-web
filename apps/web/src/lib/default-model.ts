/**
 * Default AI model resolver.
 *
 * Reads the system-wide default model from SystemSetting key 'ai.default-model'.
 * Value is either:
 *   'claude'          — Claude via the orion-claude sidecar (OAuth stays in the sidecar)
 *   '<ExternalModel id>' — use that ExternalModel (OpenAI-compatible or Ollama)
 *
 * callDefaultModel(prompt) handles the routing transparently so callers don't
 * need to know which model is configured.
 *
 * Falls back to the first enabled ExternalModel if no default is set, then
 * to Claude as a last resort.
 */

import { prisma } from './db'
import { completeOnce, claudeTarget, targetForExternalModel } from './agent-runner/engine/complete'
import { ProviderHttpError } from './agent-runner/engine/types'

const SETTING_KEY = 'ai.default-model'

// Every path has an explicit timeout: a hung call would otherwise block its
// caller indefinitely — for compaction that means holding compaction.ts's
// per-room lock forever and wedging that room's replies.
const DEFAULT_TIMEOUT_MS = 120_000

// ── Resolver ──────────────────────────────────────────────────────────────────

export async function getDefaultModelId(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } })
  if (setting?.value && typeof setting.value === 'string') return setting.value

  // No setting — fall back to first enabled external model, then claude
  const first = await prisma.externalModel.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  })
  return first?.id ?? 'claude'
}

// ── Single-turn prompt call ───────────────────────────────────────────────────

/**
 * Send a single prompt to the default model and return the text response.
 * Used by one-shot AI calls that aren't part of an agent conversation.
 */
export async function callDefaultModel(prompt: string): Promise<string> {
  const modelId = await getDefaultModelId()

  const claude = claudeTarget(modelId)
  if (claude) {
    return (await completeOnce(claude, prompt, { timeoutMs: DEFAULT_TIMEOUT_MS })).text
  }

  // Defensive: the current Settings UI writes a bare ExternalModel id, but at
  // least one other call site (seed-system-agents.ts) has historically stored
  // 'ext:<id>' as an agent's llm config, and this setting has no schema
  // enforcement preventing the same shape from ending up here. Strip it so a
  // legacy/mistaken value degrades to "found the model" instead of throwing.
  const externalModelId = modelId.startsWith('ext:') ? modelId.slice('ext:'.length) : modelId
  const model = await prisma.externalModel.findUnique({ where: { id: externalModelId } })
  if (!model) {
    throw new Error(`Default model '${modelId}' not found — configure one in Settings → AI`)
  }

  const isOllama = model.provider === 'ollama'
  let text: string
  try {
    const r = await completeOnce(targetForExternalModel(model), prompt, {
      timeoutMs: isOllama ? DEFAULT_TIMEOUT_MS : (model.timeoutSecs ?? 120) * 1000,
    })
    text = r.text
  } catch (e) {
    if (e instanceof ProviderHttpError) {
      throw new Error(isOllama
        ? `Ollama returned HTTP ${e.status}`
        : `Model API returned HTTP ${e.status}: ${e.body.slice(0, 200)}`)
    }
    throw e
  }
  if (!text) throw new Error(isOllama ? 'Ollama returned an empty response' : 'Model returned an empty response')
  return text
}
