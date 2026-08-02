/**
 * Default AI model resolver.
 *
 * Reads the system-wide default model from SystemSetting key 'ai.default-model'.
 * Value is either:
 *   'claude'          — use Claude Code SDK (requires OAuth credentials)
 *   '<ExternalModel id>' — use that ExternalModel (OpenAI-compatible or Ollama)
 *
 * callDefaultModel(prompt) handles the routing transparently so callers don't
 * need to know which model is configured.
 *
 * Falls back to the first enabled ExternalModel if no default is set, then
 * to Claude as a last resort.
 */

import { prisma } from './db'
import fs from 'fs'
import path from 'path'

const SETTING_KEY = 'ai.default-model'

// ── Resolver ──────────────────────────────────────────────────────────────────

export async function getDefaultModelId(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: SETTING_KEY },
  })

  if (setting?.value && typeof setting.value === 'string') {
    return setting.value
  }

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
 * Used by generate-features, generate-tasks, and any other one-shot AI calls.
 */
export async function callDefaultModel(prompt: string): Promise<string> {
  const modelId = await getDefaultModelId()

  if (modelId === 'claude' || modelId.startsWith('claude:')) {
    return callClaude(prompt)
  }

  // Defensive: the current Settings UI writes a bare ExternalModel id, but at
  // least one other call site (seed-system-agents.ts) has historically stored
  // 'ext:<id>' as an agent's llm config, and this setting has no schema
  // enforcement preventing the same shape from ending up here. Strip it so a
  // legacy/mistaken value degrades to "found the model" instead of throwing.
  const externalModelId = modelId.startsWith('ext:') ? modelId.slice('ext:'.length) : modelId

  const model = await prisma.externalModel.findUnique({
    where: { id: externalModelId },
  })

  if (!model) {
    throw new Error(`Default model '${modelId}' not found — configure one in Settings → AI`)
  }

  if (model.provider === 'ollama') {
    return callOllama(prompt, model.baseUrl, model.modelId)
  }

  // openai / anthropic / custom — OpenAI-compatible
  return callOpenAI(prompt, model.baseUrl, model.modelId, model.apiKey ?? undefined, model.timeoutSecs)
}

// ── Provider implementations ──────────────────────────────────────────────────

// Every other provider path here (callOpenAI, callOllama) has an explicit
// timeout via AbortSignal. The Claude Code SDK's query() has no built-in one,
// so without this, a hung SDK call blocks its caller indefinitely — for
// compaction specifically, that means holding compaction.ts's per-room
// compactingRooms entry forever, wedging that room's replies since
// triggerRoomAgentReplies awaits compactRoom() inline.
const CLAUDE_TIMEOUT_MS = 120_000

async function callClaude(prompt: string): Promise<string> {
  // Set up credentials
  if (process.env.CLAUDE_CREDENTIALS_PATH) {
    const src = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
    const destDir = path.join('/tmp/claude-home', '.claude')
    fs.mkdirSync(destDir, { recursive: true })
    try { fs.copyFileSync(src, path.join(destDir, '.credentials.json')) } catch { /* ignore */ }
    process.env.HOME = '/tmp/claude-home'
  }

  const { query } = await import('@anthropic-ai/claude-code')

  const collect = async (): Promise<string> => {
    let text = ''
    const response = query({
      prompt,
      options: { allowedTools: [], maxTurns: 1 },
    })

    for await (const msg of response) {
      if (msg.type === 'assistant') {
        const m = msg as { type: 'assistant'; message: { content: Array<{ type: string; text?: string }> } }
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) text += block.text
        }
      } else if (msg.type === 'result') {
        const r = msg as { type: 'result'; subtype?: string; result?: string }
        if (r.subtype === 'success' && r.result && !text.includes(r.result.trim())) {
          text += r.result
        }
      }
    }

    return text
  }

  // Best-effort timeout: this races the collector rather than aborting the
  // underlying SDK call (query() takes no abort signal), so the orphaned
  // generator keeps running in the background — but the caller is unblocked,
  // which is what actually matters for not wedging a room's compaction.
  return Promise.race([
    collect(),
    new Promise<string>((_, reject) => {
      setTimeout(
        () => reject(new Error(`callDefaultModel: claude query timed out after ${CLAUDE_TIMEOUT_MS}ms`)),
        CLAUDE_TIMEOUT_MS,
      )
    }),
  ])
}

async function callOpenAI(
  prompt: string,
  baseUrl: string,
  modelId: string,
  apiKey?: string,
  timeoutSecs = 120,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutSecs * 1000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Model API returned HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json() as { choices?: Array<{ message: { content: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) throw new Error('Model returned an empty response')
  return content
}

async function callOllama(prompt: string, baseUrl: string, modelId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, prompt, stream: false }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`)

  const data = await res.json() as { response?: string }
  const content = data.response?.trim()

  if (!content) throw new Error('Ollama returned an empty response')
  return content
}
