import { prisma } from '@/lib/db'
import { log } from './log'
import { logTaskEvent, postToFeed } from './db-helpers'

// How long (ms) a task may sit in pending_validation before auto-escalating.
const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS ?? '') || 30 * 60 * 1000

/**
 * Escalate tasks that have been waiting for plan approval longer than
 * APPROVAL_TIMEOUT_MS (default 30 min). Posts to agent feed and assigns to the
 * first available human so the UI surfaces it as a blocked task.
 */
export async function escalateStalePendingValidation(): Promise<void> {
  const cutoff = new Date(Date.now() - APPROVAL_TIMEOUT_MS)
  const staleTasks = await prisma.task.findMany({
    where: { status: 'pending_validation', updatedAt: { lt: cutoff } },
    select: { id: true, title: true, assignedAgent: true, metadata: true, updatedAt: true },
  })
  if (staleTasks.length === 0) return

  const human = await prisma.user.findFirst({ select: { id: true } }).catch(() => null)

  for (const t of staleTasks) {
    // BUG 2 fix: `pending_validation` is overloaded — plan-approval, budget-pause,
    // and QA-review completion all use this status. Only plan-approval waits
    // should be escalated here; the other two are not "waiting for plan approval"
    // and must not be mislabeled as such.
    const tMeta = (t.metadata as Record<string, unknown> | null) ?? {}
    if (tMeta.pendingReason !== 'plan_approval') continue
    // Already escalated once — don't re-escalate every cycle forever (the
    // escalation write itself bumps updatedAt, which would otherwise make this
    // task match the staleness query again on the next run).
    if (tMeta.approvalEscalatedAt) continue

    const waitMins = Math.round((Date.now() - t.updatedAt.getTime()) / 60_000)
    const msg = `⏰ **Approval timeout**: Task **${t.title}** has been waiting for plan approval for ${waitMins} minutes. Escalating for human review.`
    log(`Escalating stale pending_validation task ${t.id} (${waitMins}m)`)

    await Promise.all([
      logTaskEvent(t.id, 'escalated', msg, t.assignedAgent ?? undefined),
      t.assignedAgent ? postToFeed(t.assignedAgent, msg, t.id).catch(() => {}) : Promise.resolve(),
      // Assign to the first human so it appears in their task queue.
      human
        ? prisma.task.update({
            where: { id: t.id },
            data: {
              assignedUserId: human.id,
              metadata: { ...(t.metadata as object ?? {}), approvalEscalatedAt: new Date().toISOString() } as object,
            },
          }).catch(() => {})
        : Promise.resolve(),
    ])
  }
}
