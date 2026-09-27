/**
 * Atomic task claiming + liveness heartbeat for the orchestrator.
 *
 * pollOnce() used to select pending tasks and only flip them to in_progress
 * deep inside runTask(), after ~8 awaits. Two workers (another replica, or old
 * and new containers overlapping during a deploy) could both pick the same task
 * in that window and run it twice. claimTask() is a compare-and-set on
 * status='pending', so exactly one worker wins.
 */

import { hostname } from 'os'
import { prisma } from '@/lib/db'

/** Identifies this worker process in Task.claimedBy. */
export const WORKER_ID = `${hostname()}:${process.pid}`

/** How often a running task's heartbeat is bumped. */
export const TASK_HEARTBEAT_INTERVAL_MS = 60_000

/** A claimed task whose heartbeat is older than this is considered orphaned. */
export const TASK_HEARTBEAT_STALE_MS = 5 * 60_000

/**
 * Atomically move a task from pending → in_progress on behalf of `workerId`.
 * Returns true only for the single caller whose update matched the row.
 */
export async function claimTask(taskId: string, workerId: string = WORKER_ID): Promise<boolean> {
  const now = new Date()
  const res = await prisma.task.updateMany({
    where: { id: taskId, status: 'pending' },
    data:  { status: 'in_progress', claimedBy: workerId, claimedAt: now, heartbeatAt: now },
  })
  return res.count === 1
}

/** Bump the heartbeat of a task this worker still owns. Returns false if ownership was lost. */
export async function heartbeatTask(taskId: string, workerId: string = WORKER_ID): Promise<boolean> {
  const res = await prisma.task.updateMany({
    where: { id: taskId, status: 'in_progress', claimedBy: workerId },
    data:  { heartbeatAt: new Date() },
  })
  return res.count === 1
}

/**
 * Return a claimed task to the pending queue (e.g. it turned out to be
 * unrunnable right now). Only succeeds while this worker still owns it.
 */
export async function releaseTaskClaim(taskId: string, workerId: string = WORKER_ID): Promise<void> {
  await prisma.task.updateMany({
    where: { id: taskId, status: 'in_progress', claimedBy: workerId },
    data:  { status: 'pending', claimedBy: null, claimedAt: null, heartbeatAt: null },
  })
}

/**
 * Where-clause for in_progress tasks whose owner has stopped heartbeating.
 * Legacy rows (claimed before heartbeats existed, or set in_progress by an
 * API route) have no heartbeat — for those fall back to updatedAt against the
 * operator-configured stuck threshold.
 */
export function staleInProgressWhere(now: Date, legacyCutoff: Date) {
  return {
    status: 'in_progress',
    OR: [
      { heartbeatAt: { lt: new Date(now.getTime() - TASK_HEARTBEAT_STALE_MS) } },
      { heartbeatAt: null, updatedAt: { lt: legacyCutoff } },
    ],
  }
}
