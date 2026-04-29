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

  if (modelId === 'claude') {
    return callClaude(prompt)
  }

  const model = await prisma.externalModel.findUnique({
    where: { id: modelId },
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
