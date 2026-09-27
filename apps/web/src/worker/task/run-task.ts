import { releaseBudgetReservation } from '@/lib/token-budget'
import { heartbeatTask, TASK_HEARTBEAT_INTERVAL_MS } from '@/workers/task-claim'
import { err } from '../log'
import { runningTasks, TASK_TIMEOUT_MS } from '../state'
import { buildTaskContext } from './context'
import { budgetGate } from './budget'
import { maybeFederate } from './federation'
import { executeRun } from './execute'
import { finalizeSuccess, pauseForPlanApproval } from './finalize'
import { handleFailure } from './failure'
import type { RunAccounting } from './types'

/**
 * Execute a task. The caller must already have claimed it via claimTask(), so
 * the row is in_progress and owned by this worker; every early-exit path either
 * moves it to another status or releases the claim.
 *
 *   buildTaskContext → budgetGate → maybeFederate → executeRun
 *     → pauseForPlanApproval | finalizeSuccess        (errors → handleFailure)
 */
export async function runTask(taskId: string): Promise<void> {
  runningTasks.add(taskId)
  const startedAt = Date.now()

  // Liveness: stuck-task recovery keys off heartbeatAt, not updatedAt, so a
  // long but healthy run is never mistaken for an orphan.
  const heartbeatHandle = setInterval(() => {
    heartbeatTask(taskId).catch(e => err(`Heartbeat failed for task ${taskId}: ${e}`))
  }, TASK_HEARTBEAT_INTERVAL_MS)

  const taskAbort = new AbortController()
  const timeoutHandle = setTimeout(() => {
    taskAbort.abort()
    console.log(`[timeout] Task ${taskId} exceeded ${TASK_TIMEOUT_MS / 60000} minutes — aborting`)
  }, TASK_TIMEOUT_MS)

  // Shared across phases so every exit path can record spent tokens (BUG 4),
  // release the budget reservation (BUG 3) and close the trace.
  const acc: RunAccounting = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    agentId: null,
    budgetReservationTokens: 0,
    trace: null,
    mainSpan: null,
  }

  try {
    const prepared = await buildTaskContext(taskId, acc)
    if (!prepared) return

    if (!(await budgetGate(prepared, acc))) return

    if (await maybeFederate(prepared)) return
    // Already in_progress since claimTask(); refresh liveness before the run.
    await heartbeatTask(taskId).catch(() => false)

    const run = await executeRun(prepared, acc, taskAbort.signal)
    if (run.pausedForApproval) {
      await pauseForPlanApproval(prepared, run, acc)
      return
    }
    await finalizeSuccess(prepared, run, acc, startedAt)
  } catch (e) {
    await handleFailure(taskId, e, acc)
  } finally {
    clearTimeout(timeoutHandle)
    clearInterval(heartbeatHandle)
    runningTasks.delete(taskId)
    // BUG 3 fix: release the in-flight budget reservation on every exit path
    // (success, federated-dispatch, plan-pause, failure) now that real usage
    // has been (or, for early-exit paths, never will be) recorded.
    if (acc.agentId && acc.budgetReservationTokens > 0) {
      await releaseBudgetReservation(acc.agentId, acc.budgetReservationTokens).catch(
        (e) => err(`[worker] releaseBudgetReservation failed for agent ${acc.agentId}: ${e instanceof Error ? e.message : e}`)
      )
    }
  }
}
