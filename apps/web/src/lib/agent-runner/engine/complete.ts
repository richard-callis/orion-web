/**
 * One-shot completions (no tools, no history): dream phases, the system
 * default model (tool generation, eval scoring, compaction) and the chat
 * summarizer. Routes to the Claude sidecar, Ollama /api/generate or an
 * OpenAI-compatible endpoint.
 */
import { runSignal } from '../abort'
import { ProviderHttpError } from './types'
import { sidecarCollect } from './providers/claude-sidecar'

export type CompletionTarget =
  | { kind: 'claude'; model?: string }
  | { kind: 'ollama'; baseUrl: string; model: string }
  | { kind: 'openai'; baseUrl: string; model: string; apiKey?: string | null }

export interface CompletionResult {
  text: string
  /** Only set when the provider reported it. */
  inputTokens?: number
  outputTokens?: number
  /** Separated reasoning trace (llama-server --reasoning-format deepseek). */
  reasoning?: string
}

export interface CompletionOptions {
  timeoutMs: number
  system?: string
  /** Ollama sampling options. */
  options?: Record<string, number>
  signal?: AbortSignal
}

/** Sidecar replied but reported an error (auth, quota…) — distinct from HTTP failures. */
export class SidecarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SidecarError'
  }
}

/**
 * Throws ProviderHttpError on a non-2xx response, SidecarError when the
 * sidecar reports an error, and whatever fetch throws on network failure.
 */
export async function completeOnce(target: CompletionTarget, prompt: string, opts: CompletionOptions): Promise<CompletionResult> {
  if (target.kind === 'claude') {
    const r = await sidecarCollect(
      // One-shot: a single turn with no tools.
      { messages: [{ role: 'user', content: prompt }], ...(opts.system !== undefined && { system: opts.system }), model: target.model, maxTurns: 1, allowedTools: [] },
      { timeoutMs: opts.timeoutMs, signal: opts.signal },
    )
    if (!r.ok) {
      if (r.status !== undefined) throw new ProviderHttpError(`orion-claude HTTP ${r.status}`, r.status, r.error)
      throw new SidecarError(r.error)
    }
    return { text: r.text, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }
  }

  if (target.kind === 'ollama') {
    const res = await fetch(`${target.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        prompt,
        stream: false,
        ...(opts.system !== undefined && { system: opts.system }),
        ...(opts.options && { options: opts.options }),
      }),
      signal: runSignal(opts.signal, opts.timeoutMs),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderHttpError(`Ollama HTTP ${res.status}`, res.status, body)
    }
    const data = await res.json() as { response?: string; prompt_eval_count?: number; eval_count?: number }
    return { text: data.response?.trim() ?? '', inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`
  const messages = [
    ...(opts.system !== undefined ? [{ role: 'system', content: opts.system }] : []),
    { role: 'user', content: prompt },
  ]
  const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: target.model, stream: false, messages }),
    signal: runSignal(opts.signal, opts.timeoutMs),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ProviderHttpError(`Model API returned HTTP ${res.status}`, res.status, body)
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const msg = data.choices?.[0]?.message
  return {
    text: msg?.content?.trim() ?? '',
    reasoning: msg?.reasoning_content?.trim() || undefined,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }
}

interface ExternalModelRow {
  provider: string
  baseUrl: string
  modelId: string
  apiKey?: string | null
  timeoutSecs?: number | null
}

/** Completion target for a stored ExternalModel row. */
export function targetForExternalModel(m: ExternalModelRow): CompletionTarget {
  return m.provider === 'ollama'
    ? { kind: 'ollama', baseUrl: m.baseUrl, model: m.modelId }
    : { kind: 'openai', baseUrl: m.baseUrl, model: m.modelId, apiKey: m.apiKey }
}

/** 'claude' / 'claude:<model>' → sidecar target; anything else is not a Claude id. */
export function claudeTarget(modelId: string): CompletionTarget | null {
  if (modelId === 'claude') return { kind: 'claude' }
  if (modelId.startsWith('claude:')) return { kind: 'claude', model: modelId.slice('claude:'.length) }
  return null
}
