import { prisma } from '@/lib/db'
import {
  checkAgentBudget,
  acquireBudgetLock,
  releaseBudgetLock,
  reserveBudgetTokens,
} from '@/lib/token-budget'
import { releaseTaskClaim } from '@/workers/task-claim'
import { log } from '../log'
import { freshTaskMetadata, logTaskEvent, postToFeed } from '../db-helpers'
import type { PreparedTask, RunAccounting } from './types'

/**
 * Budget gate. Returns true to proceed; false when the task was deferred
 * (lock contention — claim released) or paused (over budget).
 * On success an estimated spend is reserved in `acc`, released by runTask.
 */
export async function budgetGate(p: PreparedTask, acc: RunAccounting): Promise<boolean> {
  const { taskId, task, agent, taskMeta } = p
  // SOC2: [H-TOCTOU] Acquire per-agent mutex before reading usage to prevent
  // concurrent tasks all seeing the same stale usage total before any records.
  const budgetLockToken = await acquireBudgetLock(agent.id)
  if (budgetLockToken === null) {
    // Another task holds the budget lock for this agent — re-queue and retry later.
    await releaseTaskClaim(taskId)
    log(`Task "${task.title}" (${taskId}) deferred — budget lock held by another task`)
    return false
  }
  let budgetCheck: { allowed: boolean; reason?: string }
  try {
    budgetCheck = await checkAgentBudget(agent.id)
    // BUG 3 fix: reserve an estimated spend WHILE still holding the lock so
    // the check-then-reserve pair is atomic w.r.t. other concurrent tasks for
    // this agent. checkAgentBudget() folds any outstanding reservation into
    // its sums, so subsequent concurrent checks see this reservation.
    // Released in runTask's `finally` once real usage is recorded.
    if (budgetCheck.allowed) {
      acc.budgetReservationTokens = await reserveBudgetTokens(agent.id)
    }
  } finally {
    await releaseBudgetLock(agent.id, budgetLockToken)
  }
  if (!budgetCheck.allowed) {
    const budgetMsg = `Budget gate: ${budgetCheck.reason} — task paused until budget resets or limit is increased.`
    // BUG 6 fix: taskMeta was snapshotted before the (potentially slow) budget
    // lock/check above — re-fetch immediately before this whole-object write.
    const currentMeta = await freshTaskMetadata(taskId, taskMeta)
    await Promise.all([
      prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'pending_validation',
          metadata: { ...currentMeta, budgetExceeded: true, budgetReason: budgetCheck.reason, pendingReason: 'budget_paused' } as object,
        },
      }),
      logTaskEvent(taskId, 'budget_gate', budgetMsg, agent.id),
      postToFeed(agent.id, `⛔ ${budgetMsg}`, taskId),
    ])
    log(`Task "${task.title}" (${taskId}) paused — ${budgetCheck.reason}`)
    return false
  }
  return true
}
