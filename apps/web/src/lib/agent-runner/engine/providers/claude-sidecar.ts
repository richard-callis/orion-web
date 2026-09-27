/**
 * orion-claude sidecar adapter. The sidecar runs the Claude Code CLI with the
 * OAuth credentials that never leave its container, and executes tools itself
 * (built-in tools and ORION tools over MCP) — so this adapter is a request
 * builder + response parser, not a tool loop.
 *
 * Requests are structured for prompt caching:
 *   system   — the stable system prompt (persona/template). Claude Code caches
 *              the system prompt + tool definitions automatically, so keeping
 *              this byte-identical across turns is what earns cache hits.
 *   context  — volatile per-turn context (injected skills, RAG notes). Sent in
 *              the user turn, never appended to `system`.
 *   messages — history + the new user message; the sidecar renders them.
 * The legacy `prompt` / `systemPrompt` fields are always sent as well, so an
 * older sidecar that doesn't know the structured fields still works.
 */
import { runSignal } from '../../abort'

export const SIDECAR_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

export interface SidecarMessage {
  role: string
  content: string
  /** Speaker name (room transcripts). */
  name?: string
}

export interface SidecarRequest {
  /** Stable system prompt. */
  system?: string
  /** Volatile per-turn context, rendered into the user turn. */
  context?: string
  /** History plus the new user message (last). */
  messages: SidecarMessage[]
  /**
   * How prior messages are rendered: 'chat' → "role: content" blocks separated
   * by blank lines; 'room' → "Name: content" lines.
   */
  transcript?: 'chat' | 'room'
  model?: string
  maxTurns?: number
  agentId?: string
  roomId?: string
  allowedTools?: string[]
  mcpToken?: string
  nebula?: { environmentId: string; traceId: string }
}

/**
 * The flattened prompt an older sidecar expects. Must stay byte-identical to
 * the pre-structured formats (the sidecar's renderPrompt produces the same).
 */
export function renderLegacyPrompt(req: Pick<SidecarRequest, 'messages' | 'transcript'>): string {
  const msgs = req.messages
  if (msgs.length === 0) return ''
  const last = msgs[msgs.length - 1].content
  const prior = msgs.slice(0, -1)
  if (req.transcript === 'room') {
    const block = prior.length ? prior.map(m => `${m.name ?? m.role}: ${m.content}`).join('\n') + '\n\n' : ''
    return block + last
  }
  return prior.length ? prior.map(m => `${m.role}: ${m.content}`).join('\n\n') + `\n\nuser: ${last}` : last
}

function legacySystemPrompt(req: SidecarRequest): string | undefined {
  if (req.system === undefined && !req.context) return undefined
  return (req.system ?? '') + (req.context ?? '')
}

export function buildSidecarBody(req: SidecarRequest): Record<string, unknown> {
  const systemPrompt = legacySystemPrompt(req)
  return {
    prompt: renderLegacyPrompt(req),
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(req.system !== undefined && { system: req.system }),
    ...(req.context && { context: req.context }),
    messages: req.messages,
    ...(req.transcript && { transcript: req.transcript }),
    ...(req.allowedTools && { allowedTools: req.allowedTools }),
    ...(req.maxTurns !== undefined && { maxTurns: req.maxTurns }),
    ...(req.model && { model: req.model }),
    ...(req.agentId && { agentId: req.agentId }),
    ...(req.roomId && { roomId: req.roomId }),
    ...(req.nebula && { nebula: req.nebula }),
    ...(req.mcpToken && { mcpToken: req.mcpToken }),
  }
}

export interface SidecarUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

interface CollectResponse {
  text?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  usage?: SidecarUsage & { input_tokens?: number; output_tokens?: number }
}

export type SidecarCollectResult =
  | { ok: true; text: string; usage: { inputTokens?: number; outputTokens?: number } }
  | { ok: false; error: string; status?: number }

/** Normalise the usage field names the sidecar has used across versions. */
function readUsage(d: CollectResponse): { inputTokens?: number; outputTokens?: number } {
  return {
    inputTokens:  d.inputTokens  ?? d.usage?.inputTokens  ?? d.usage?.input_tokens,
    outputTokens: d.outputTokens ?? d.usage?.outputTokens ?? d.usage?.output_tokens,
  }
}

/**
 * POST /run/collect. Network failures reject (callers decide whether to swallow
 * them); HTTP and sidecar-reported errors resolve to { ok: false }.
 */
export async function sidecarCollect(
  req: SidecarRequest,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SidecarCollectResult> {
  const res = await fetch(`${SIDECAR_URL}/run/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSidecarBody(req)),
    signal: runSignal(opts.signal, opts.timeoutMs),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: body }
  }
  const data = await res.json() as CollectResponse
  if (data.error) return { ok: false, error: data.error }
  return { ok: true, text: data.text ?? '', usage: readUsage(data) }
}

export type SidecarEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: string }
  | { type: 'result'; subtype?: string; result?: string }

interface SdkLine {
  type?: string
  error?: string
  subtype?: string
  result?: string
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }> }
}

/** Parse one NDJSON line from /run into events. Throws on an SDK error event. */
export function parseSidecarLine(line: string): SidecarEvent[] {
  if (!line.trim()) return []
  let msg: SdkLine
  try { msg = JSON.parse(line) as SdkLine } catch { return [] }
  if (msg.type === 'error') throw new Error(msg.error ?? 'Unknown error from orion-claude')
  const out: SidecarEvent[] = []
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text })
      else if (block.type === 'tool_use') out.push({ type: 'tool_use', name: block.name ?? '', input: block.input ?? {} })
    }
  } else if (msg.type === 'user') {
    for (const block of msg.message?.content ?? []) {
      if (block.type !== 'tool_result') continue
      const content = Array.isArray(block.content)
        ? (block.content as Array<{ type: string; text?: string }>).map(c => c.type === 'text' ? c.text : '').join('')
        : String(block.content ?? '')
      out.push({ type: 'tool_result', content })
    }
  } else if (msg.type === 'result') {
    out.push({ type: 'result', subtype: msg.subtype, result: msg.result })
  }
  return out
}

/**
 * POST /run and stream parsed events. The upstream body is cancelled on any
 * early exit (error, abort, consumer stopped) so the sidecar run stops instead
 * of burning tokens with nobody listening.
 */
export async function* sidecarStream(
  req: SidecarRequest,
  opts: { timeoutMs: number; signal?: AbortSignal },
): AsyncGenerator<SidecarEvent> {
  const res = await fetch(`${SIDECAR_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSidecarBody(req)),
    // A caller-supplied signal replaces the default timeout (chat runs are
    // bounded by the client connection, not a fixed deadline).
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs),
  })
  if (!res.ok || !res.body) throw new Error(`orion-claude /run returned ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (opts.signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) {
        // Flush the final line when the stream doesn't end with a newline
        buf += decoder.decode()
        yield* parseSidecarLine(buf)
        break
      }
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) yield* parseSidecarLine(line)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}
