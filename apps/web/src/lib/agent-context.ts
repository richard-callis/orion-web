/**
 * Pre-flight context injection for room agents.
 *
 * Before each LLM call, this module assembles two context blocks:
 *
 * 1. ORION snapshot — agents, active tasks, recent events.
 *    Cached via system-cache with a configurable TTL (default 2 min).
 *
 * 2. Knowledge base — semantically relevant notes from the vector store.
 *    Embedding query is the latest user message. Silently skipped if no
 *    embedding provider is configured.
 *
 * The combined block is injected into every agent's system prompt so the
 * model arrives pre-oriented and can answer most questions without any
 * tool calls.
 */

import { prisma } from './db'
import { retrieveKnowledgeContext } from './embeddings'
import { getOrFetch, invalidate } from './system-cache'

// ── Snapshot fetcher (pure — no caching, system-cache handles that) ────────────

async function fetchSnapshot(): Promise<string> {
  try {
    const [agents, tasks, events] = await Promise.all([
      prisma.agent.findMany({ orderBy: { name: 'asc' } }),
      prisma.task.findMany({
        where: { status: { in: ['pending', 'in_progress', 'blocked'] } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        include: { agent: { select: { name: true } } },
      }),
      prisma.taskEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { task: { select: { title: true } } },
      }),
    ])

    const activeAgents = agents.filter(
      (a: any) => (a.metadata as Record<string, unknown> | null)?.archived !== true,
    )
    const agentLines = activeAgents
      .map((a: any) => `  ${a.name} (${a.status})${a.role ? ' — ' + a.role : ''}`)
      .join('\n')
    const taskLines = tasks
      .map(
        (t: any) =>
          `  [${t.id}] ${t.title} — ${t.status}, assigned: ${t.agent?.name ?? 'unassigned'}`,
      )
      .join('\n')
    const eventLines = events
      .map((e: any) => `  [${e.taskId}] ${e.task?.title ?? '?'}: ${e.eventType}`)
      .join('\n')

    return [
      `## ORION State (cached ${new Date().toISOString()})`,
      `**Agents (${activeAgents.length}):**`,
      agentLines || '  none',
      '',
      `**Active Tasks (${tasks.length}):**`,
      taskLines || '  none',
      '',
      `**Recent Events:**`,
      eventLines || '  none',
    ].join('\n')
  } catch (err) {
    // Never block an LLM call over a snapshot failure
    console.warn('[agent-context] snapshot fetch failed:', err)
    return ''
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a context block to prepend to an agent's system prompt.
 *
 * @param query - The latest user message, used as the vector search query.
 * @returns A formatted markdown string (may be empty if both sources fail).
 */
export async function buildAgentContext(query: string): Promise<string> {
  const [snapshot, knowledge] = await Promise.all([
    getOrFetch('snapshot', 'cache.snapshot.ttl', fetchSnapshot).catch(() => ''),
    retrieveKnowledgeContext(query, 3, 0.4),
  ])

  const parts: string[] = []
  if (snapshot) parts.push(snapshot)
  if (knowledge) {
    parts.push('## Relevant Knowledge Base Notes')
    parts.push(knowledge)
  }

  if (parts.length === 0) return ''
  return '\n\n---\n' + parts.join('\n\n') + '\n---'
}

/** Explicitly invalidate the snapshot cache (call after write operations). */
export function invalidateSnapshotCache(): void {
  invalidate('snapshot')
}

// ── Dynamic context limit discovery ──────────────────────────────────────────
// Hits the llama.cpp /props endpoint to discover n_ctx for OpenAI-compat
// endpoints. Cached per baseUrl with a 10-minute TTL so transient network
// failures don't permanently lock a model to the 8192 fallback.

const CONTEXT_LIMIT_TTL_MS = 10 * 60 * 1000  // 10 minutes
const contextLimitCache = new Map<string, { value: number; expiresAt: number }>()

/**
 * Discover the context window size for an OpenAI-compatible model endpoint.
 * Uses llama.cpp's GET /props (returns { n_ctx: number, ... }).
 * Result is cached per baseUrl for 10 minutes; falls back to 8192.
 */
export async function getModelContextLimit(baseUrl: string): Promise<number> {
  const cached = contextLimitCache.get(baseUrl)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/props`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      // llama.cpp /props: n_ctx is at data.default_generation_settings.n_ctx
      // Fall back to top-level data.n_ctx for other implementations, then 8192
      const dgs = data.default_generation_settings as Record<string, unknown> | undefined
      const n_ctx = typeof dgs?.n_ctx === 'number' ? dgs.n_ctx
                  : typeof data.n_ctx === 'number'  ? data.n_ctx
                  : 8192
      contextLimitCache.set(baseUrl, { value: n_ctx, expiresAt: Date.now() + CONTEXT_LIMIT_TTL_MS })
      return n_ctx
    }
  } catch { /* ignore — not llama.cpp or unreachable */ }

  // Cache the fallback too, but with a shorter TTL so we retry sooner
  contextLimitCache.set(baseUrl, { value: 8192, expiresAt: Date.now() + 60_000 })
  return 8192
}

export async function buildAgentLocalContext(agentId: string): Promise<string> {
  try {
    const knowledge = await prisma.agentKnowledge.findMany({
      where: { agentId },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    })
    if (knowledge.length === 0) return ''
    const lines = knowledge.map(k => {
      const tag = k.type !== 'note' ? ` [${k.type}]` : ''
      return `### ${k.title}${tag}\n${k.content.slice(0, 2000)}`
    })
    return ['## Agent-Local Knowledge', ...lines].join('\n\n---\n\n')
  } catch (err) {
    console.warn('[agent-context] agent local knowledge fetch failed:', err)
    return ''
  }
}

export async function buildRoomLocalContext(roomId: string): Promise<string> {
  try {
    const knowledge = await prisma.roomKnowledge.findMany({
      where: { roomId },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    })
    if (knowledge.length === 0) return ''
    const lines = knowledge.map(k => {
      const tag = k.type !== 'note' ? ` [${k.type}]` : ''
      return `### ${k.title}${tag}\n${k.content.slice(0, 2000)}`
    })
    return ['## Room Knowledge', ...lines].join('\n\n---\n\n')
  } catch (err) {
    console.warn('[agent-context] room local knowledge fetch failed:', err)
    return ''
  }
}
