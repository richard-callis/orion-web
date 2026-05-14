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

// ── Agent-local knowledge ────────────────────────────────────────────────────

/**
 * Fetch and format agent-local knowledge for a given agent.
 * Used during delegation to inject the specialist's learned knowledge into their context.
 */
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

// ── Room-local knowledge ─────────────────────────────────────────────────────

/**
 * Fetch and format room-local knowledge for a given room.
 * Used during delegation to inject room-specific context.
 */
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
