/**
 * Test harness: a scripted fake `fetch` for LLM providers, the orion-claude
 * sidecar and gateways. Each route matches a URL predicate and serves queued
 * responses in order; every call is recorded (url + parsed JSON body) so tests
 * can assert on request shapes as well as on the events a loop yields.
 *
 * Used by the engine characterization tests — they must keep passing before
 * and after the LLM-engine consolidation, so they only touch module boundaries
 * that survive it: HTTP, Prisma and the policy/registry modules.
 */
import { vi } from 'vitest'

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Responder = (call: RecordedCall) => Response | Promise<Response>

interface Route {
  match: (url: string) => boolean
  queue: Responder[]
  /** Served when the queue is empty (optional). */
  fallback?: Responder
}

export class FakeHttp {
  readonly calls: RecordedCall[] = []
  private routes: Route[] = []

  route(match: string | RegExp | ((url: string) => boolean), ...responses: Responder[]): this {
    const m = typeof match === 'string'
      ? (u: string) => u.includes(match)
      : match instanceof RegExp ? (u: string) => match.test(u) : match
    this.routes.push({ match: m, queue: [...responses] })
    return this
  }

  always(match: string | RegExp, responder: Responder): this {
    const m = typeof match === 'string' ? (u: string) => u.includes(match) : (u: string) => match.test(u)
    this.routes.push({ match: m, queue: [], fallback: responder })
    return this
  }

  callsTo(fragment: string): RecordedCall[] {
    return this.calls.filter(c => c.url.includes(fragment))
  }

  install(): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (init.signal?.aborted) {
        const e = new Error('This operation was aborted')
        e.name = 'AbortError'
        throw e
      }
      let body: unknown = undefined
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body) } catch { body = init.body }
      }
      const headers: Record<string, string> = {}
      const h = init.headers
      if (h && typeof h === 'object' && !Array.isArray(h) && !(h instanceof Headers)) {
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = String(v)
      }
      const call: RecordedCall = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body }
      this.calls.push(call)
      const route = this.routes.find(r => r.match(url) && (r.queue.length > 0 || r.fallback))
      if (!route) throw new Error(`FakeHttp: no route for ${call.method} ${url}`)
      const responder = route.queue.shift() ?? route.fallback!
      return responder(call)
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }
}

// ── Response builders ─────────────────────────────────────────────────────────

export const json = (body: unknown, status = 200): Responder =>
  () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const text = (body: string, status = 200): Responder =>
  () => new Response(body, { status })

/** A streaming body built from raw string chunks (exact bytes the provider would send). */
export const stream = (chunks: string[], status = 200): Responder =>
  () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  }), { status })

/** OpenAI-compatible SSE: one `data:` line per delta object, then [DONE]. */
export function openaiSSE(deltas: Array<Record<string, unknown>>): string[] {
  return [
    ...deltas.map(d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`),
    'data: [DONE]\n\n',
  ]
}

/** Non-streaming OpenAI chat completion. */
export function openaiCompletion(
  message: { content?: string | null; tool_calls?: Array<{ id: string; name: string; arguments: string }> },
  usage?: { prompt_tokens: number; completion_tokens: number },
): Responder {
  const tool_calls = message.tool_calls?.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
  return json({
    choices: [{
      finish_reason: tool_calls?.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: message.content ?? null, ...(tool_calls && { tool_calls }) },
    }],
    ...(usage && { usage }),
  })
}

/** Non-streaming Ollama /api/chat reply. */
export function ollamaChat(
  message: { content?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> | string }> },
  extra: Record<string, unknown> = {},
): Responder {
  return json({
    message: {
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls && { tool_calls: message.tool_calls.map(tc => ({ function: tc })) }),
    },
    done: true,
    ...extra,
  })
}

/** Streaming Ollama NDJSON. */
export function ollamaNDJSON(texts: string[]): string[] {
  return [...texts.map(t => JSON.stringify({ message: { content: t }, done: false }) + '\n'), JSON.stringify({ done: true }) + '\n']
}

/** Gemini SSE stream. */
export function geminiSSE(texts: string[]): string[] {
  return texts.map(t => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`)
}

/** orion-claude /run NDJSON events. */
export function sidecarNDJSON(events: Array<Record<string, unknown>>): string[] {
  return events.map(e => JSON.stringify(e) + '\n')
}

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of gen) out.push(e)
  return out
}

/** Consume like the chat SSE route: stop after the first done/error. */
export async function collectUntilTerminal<T extends { type: string }>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of gen) {
    out.push(e)
    if (e.type === 'done' || e.type === 'error') break
  }
  return out
}
