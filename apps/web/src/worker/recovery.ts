import { prisma } from '@/lib/db'
import { staleInProgressWhere } from '@/workers/task-claim'
import { freshTaskMetadata } from './db-helpers'
import { runningTasks } from './state'

export async function recoverStuckTasks() {
  // Allow overriding the 30-min default via SystemSetting (minutes)
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'worker.stuckTaskMinutes' } }).catch(() => null)
  const stuckMinutes = Math.max(10, parseInt(String(setting?.value ?? '30'), 10) || 30)
  const stuckCutoff = new Date(Date.now() - stuckMinutes * 60 * 1000)
  // Claimed tasks are recovered once their owner stops heartbeating; legacy /
  // externally-set in_progress rows with no heartbeat fall back to updatedAt.
  const stuck = await prisma.task.findMany({
    where: staleInProgressWhere(new Date(), stuckCutoff),
    take: 500, // bounded; federated rows are skipped in-loop, so leave headroom
  })
  for (const task of stuck) {
    // Federated tasks run on a spoke; pollFederatedTasks owns their lifecycle.
    if ((task.metadata as Record<string, unknown> | null)?.federated === true) continue
    // BUG 5 fix: `Task.updatedAt` is only bumped on status transitions, not on
    // individual tool calls — a task legitimately running for 30-60 minutes
    // (well within TASK_TIMEOUT_MS's 60-minute allowance) would otherwise look
    // "stuck" and get falsely requeued/failed out from under itself. If this
    // process still has the task in its in-memory `runningTasks` set, it's
    // actively executing here — skip it. This only guards against
    // self-sabotage within one process; a task stuck on a crashed process
    // (not in this process's runningTasks) is still recovered normally.
    if (runningTasks.has(task.id)) {
      console.log(`[recovery] Skipping task ${task.id} — still actively running in this process`)
      continue
    }
    // Don't fail tasks that have a pending retry scheduled in the future
    if (task.nextRetryAt && task.nextRetryAt > new Date()) {
      console.log(`[recovery] Skipping task ${task.id} — retry scheduled at ${task.nextRetryAt.toISOString()}`)
      continue
    }
    // BUG 6 fix: `task.metadata` is a batch snapshot from the findMany() above,
    // taken before earlier iterations of this loop performed their own awaits
    // — re-fetch immediately before this whole-object write to avoid clobbering
    // a concurrent edit.
    const currentMeta = await freshTaskMetadata(task.id, task.metadata as object ?? {})
    const retries = ((currentMeta as { recoveryCount?: number }).recoveryCount ?? 0)
    const MAX_RECOVERY = 2
    const newStatus = retries < MAX_RECOVERY ? 'pending' : 'failed'
    const newMeta = { ...(currentMeta as object ?? {}), recoveryCount: retries + 1 }
    // Compare-and-set on the stale claim so a worker that just resumed
    // heartbeating (or another recovery pass) doesn't get clobbered.
    const recovered = await prisma.task.updateMany({
      where: { id: task.id, status: 'in_progress', claimedBy: task.claimedBy, heartbeatAt: task.heartbeatAt },
      data: {
        status: newStatus,
        assignedAgent: newStatus === 'pending' ? task.assignedAgent : null,
        metadata: newMeta as object,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
      },
    })
    if (recovered.count === 0) continue
    await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        eventType: 'system',
        content: newStatus === 'pending'
          ? `Task re-queued after its worker (${task.claimedBy ?? 'unknown'}) stopped responding. Recovery attempt ${retries + 1}/${MAX_RECOVERY}.`
          : `Task failed after ${MAX_RECOVERY} recovery attempts. Use orion_reopen_task to retry manually.`,
        agentId: null
      }
    })
    console.log(`[recovery] Recovered stuck task ${task.id} — ${newStatus} (attempt ${retries + 1}, threshold ${stuckMinutes}min)`)
  }
  if (stuck.length > 0) console.log(`[recovery] Recovered ${stuck.length} stuck task(s)`)
}
