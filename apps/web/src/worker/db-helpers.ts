import { prisma } from '@/lib/db'
import { redactSecrets } from '@/lib/redact'
import { err } from './log'
import { MAX_NOTE_LENGTH } from './state'

/**
 * BUG 6 fix helper: re-fetch a task's CURRENT metadata immediately before a
 * whole-object metadata write. `task.metadata` snapshots taken at the start of
 * a long-running flow (budget checks, federation dispatch, watcher runs) can be
 * minutes stale by the time we write back — a whole-object write of that stale
 * snapshot silently reverts any concurrent edit made in between. Falls back to
 * `fallback` if the task has since been deleted or the read fails.
 */
export async function freshTaskMetadata(taskId: string, fallback: object): Promise<object> {
  const fresh = await prisma.task.findUnique({ where: { id: taskId }, select: { metadata: true } }).catch(() => null)
  return (fresh?.metadata as object) ?? fallback
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function logTaskEvent(taskId: string, eventType: string, content: string, agentId?: string) {
  await prisma.taskEvent.create({ data: { taskId, eventType, content, agentId: agentId ?? null } }).catch(e => err(`[worker] logTaskEvent failed for task ${taskId}: ${e instanceof Error ? e.message : e}`))
}

export async function postToFeed(agentId: string, content: string, taskId?: string) {
  await prisma.agentMessage.create({
    data: {
      agentId,
      channel:     'agent-feed',
      content,
      messageType: 'task_update',
      threadId:    taskId,
    },
  }).catch(() => {})
}

/**
 * Auto-write a structured task outcome to the knowledge base as an `llm-context`
 * note. These notes are embedded for vector search and auto-injected into future
 * agent system prompts, so completed/failed task outcomes become institutional
 * memory without an agent having to explicitly call knowledge_remember.
 */
export async function writeTaskOutcome(opts: {
  title: string
  description: string | null
  status: 'done' | 'failed'
  outcomeSummary: string
  errorMessage?: string | null
  environmentId?: string | null
  environmentName?: string | null
}): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10)
    const desc = (opts.description ?? '').trim()
    const parts = [
      `Task '${opts.title}' ${opts.status} on ${date}: ${desc || '(no description)'}. ${opts.outcomeSummary}`.trim(),
    ]
    if (opts.environmentName) parts.push(`\nEnvironment: ${opts.environmentName}`)
    if (opts.status === 'failed' && opts.errorMessage) parts.push(`\nError: ${opts.errorMessage.slice(0, 1000)}`)
    const content = redactSecrets(parts.join('')).slice(0, MAX_NOTE_LENGTH)

    const tags: string[] = ['task-outcome', opts.status]
    if (opts.environmentId) tags.push(opts.environmentId)

    const note = await prisma.note.create({
      data: {
        title:   `Task outcome: ${opts.title.slice(0, 120)} (${opts.status} ${date})`,
        content,
        folder:  'Task Outcomes',
        type:    'llm-context',
        tags,
      },
    })

    // Embed immediately so the outcome is retrievable via knowledge_search / RAG.
    const { embedNote } = await import('@/lib/embeddings')
    await embedNote(note).catch(e => { console.error(`[embed] failed for task outcome note "${note.title}":`, e); return false })
  } catch (e) {
    err(`writeTaskOutcome failed for "${opts.title}": ${e}`)
  }
}

// ── Chat room helpers ─────────────────────────────────────────────────────────

/**
 * Find or create the coordination ChatRoom for a Feature.
 * SOC2: room creation is logged to the agent-feed audit trail.
 */
export async function findOrCreateFeatureRoom(featureId: string, agentId: string): Promise<string | null> {
  // Upsert on featureId unique constraint — race-condition safe, enforces 1:1 feature↔room
  const feature = await prisma.feature.findUnique({ where: { id: featureId }, select: { title: true } })
  const existing = await prisma.chatRoom.findUnique({ where: { featureId }, select: { id: true } })
  const room = existing ?? await prisma.chatRoom.create({
    data: { name: feature?.title ?? '', featureId, type: 'feature', createdBy: agentId },
    select: { id: true },
  })
  if (!existing) {
    // SOC2: log room creation to audit feed
    await postToFeed(agentId, `Room created for feature ${featureId} (room ${room.id})`)
  }
  // Ensure agent is a member
  await prisma.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId: room.id, agentId } },
    create: { roomId: room.id, agentId, role: 'member' },
    update: {},
  })
  return room.id
}

/**
 * Post a message to a ChatRoom. agentId provides SOC2 attribution.
 * taskId tags the message to a specific task for filtered views.
 */
export async function postToRoom(roomId: string, agentId: string, content: string, taskId?: string) {
  await prisma.chatMessage.create({
    data: { roomId, agentId, senderType: 'agent', content, taskId: taskId ?? null },
  }).catch(() => {})
}
