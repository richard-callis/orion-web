import { prisma } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { executeManagedTool } from '@/lib/management-tools'
import { recordTokenUsage } from '@/lib/token-budget'
import { isAbortErrorMessage } from '@/lib/agent-runner/abort'
import { err } from '../log'
import { logTaskEvent, postToFeed, writeTaskOutcome } from '../db-helpers'
import type { RunAccounting } from './types'

/**
 * Whether a failure may be retried. Client-side aborts/timeouts are terminal:
 * the run may have been cut off after tools with side effects already ran, and
 * a retry would execute them again.
 */
export function isTransientError(errorMessage: string): boolean {
  if (isAbortErrorMessage(errorMessage)) return false
  const transientPatterns = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
    'rate_limit', '429', '503', '502',
    'timeout', 'Gateway timeout', 'upstream connect error',
    'Connection reset', 'socket hang up'
  ]
  return transientPatterns.some(p => errorMessage.toLowerCase().includes(p.toLowerCase()))
}

/**
 * Failed run: flush the trace, record spent tokens, then escalate (repeated
 * failures), schedule a retry (transient errors) or fail the task.
 */
export async function handleFailure(taskId: string, e: unknown, acc: RunAccounting): Promise<void> {
  const errMsg = e instanceof Error ? e.message : String(e)
  err(`Task ${taskId} failed: ${errMsg}`)

  // Langfuse: flush trace on failure
  if (acc.trace) {
    if (acc.mainSpan) acc.trace.endSpan(acc.mainSpan, undefined, errMsg)
    await acc.trace.flush().catch(() => {})
  }

  const failedTask = await prisma.task.findUnique({
    where: { id: taskId },
    select: { title: true, description: true, assignedAgent: true, retryCount: true, maxRetries: true, metadata: true },
  }).catch(() => null)

  // BUG 4 fix: token spend on failed/timed-out runs was previously dropped
  // entirely (recordTokenUsage was only called on the success path), so an
  // agent looping on transient failures burned real tokens with zero budget
  // accounting. Record whatever was spent before the failure, on every
  // failure branch below (including retries — each attempt burns tokens).
  const failureAgentId = acc.agentId ?? failedTask?.assignedAgent ?? null
  if (failureAgentId && (acc.totalInputTokens > 0 || acc.totalOutputTokens > 0)) {
    await recordTokenUsage(failureAgentId, taskId, acc.totalInputTokens, acc.totalOutputTokens).catch(
      (re) => err(`[worker] recordTokenUsage (failure path) failed for task ${taskId}: ${re instanceof Error ? re.message : re}`)
    )
  }

  // ── Remediation loop detection ──────────────────────────────────────────
  // Track how many times this task has hit the failure path with the same
  // approach. Once it has failed 2+ times we stop retrying and escalate for
  // human review instead of looping on a strategy that clearly is not working.
  const failMeta = (failedTask?.metadata as Record<string, unknown> | null) ?? {}
  const remediationAttempts = (typeof failMeta.remediation_attempts === 'number' ? failMeta.remediation_attempts : 0) + 1
  const exhaustedRemediation = remediationAttempts >= 2

  const canRetry = !exhaustedRemediation && isTransientError(errMsg) && (failedTask?.retryCount ?? 0) < (failedTask?.maxRetries ?? 3)

  if (exhaustedRemediation) {
    // Persist the incremented attempt counter and stop retrying.
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'failed',
        metadata: { ...failMeta, remediation_attempts: remediationAttempts } as object,
      },
    }).catch(e2 => err(`[worker] task status update failed for ${taskId}: ${e2 instanceof Error ? e2.message : e2}`))
    const escalationMsg =
      `Task '${failedTask?.title ?? taskId}' has failed ${remediationAttempts} times with the same approach. Escalating — human review required. Last error: ${errMsg.slice(0, 300)}`
    await logTaskEvent(taskId, 'escalated', escalationMsg, failedTask?.assignedAgent ?? undefined)
    if (failedTask?.assignedAgent) {
      await postToFeed(failedTask.assignedAgent, `🚨 ${escalationMsg}`, taskId).catch(() => {})
    }
    // Escalate to a human operator if one exists (orion_escalate_task needs a user_id).
    const human = await prisma.user.findFirst({ select: { id: true } }).catch(() => null)
    if (human && failedTask?.assignedAgent) {
      await executeManagedTool(
        'orion_escalate_task',
        JSON.stringify({ task_id: taskId, user_id: human.id }),
        failedTask.assignedAgent,
      ).catch((e2) => err(`Auto-escalation failed for ${taskId}: ${e2}`))
    }
    await writeTaskOutcome({
      title:           failedTask?.title ?? taskId,
      description:     failedTask?.description ?? null,
      status:         'failed',
      outcomeSummary: `Failed ${remediationAttempts} times with the same approach — escalated for human review.`,
      errorMessage:    errMsg,
    })
    await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})
  } else if (canRetry && failedTask) {
    const newRetryCount = (failedTask.retryCount ?? 0) + 1
    const delayMs = 15000 * Math.pow(2, failedTask.retryCount ?? 0) // 15s, 30s, 60s
    const nextRetryAt = new Date(Date.now() + delayMs)
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        retryCount: newRetryCount,
        nextRetryAt,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        metadata: { ...failMeta, remediation_attempts: remediationAttempts } as object,
      },
    }).catch(e2 => err(`[worker] task retry status update failed for ${taskId}: ${e2 instanceof Error ? e2.message : e2}`))
    await logTaskEvent(taskId, 'system',
      `Transient failure (${errMsg.slice(0, 100)}) — retry ${newRetryCount}/${failedTask.maxRetries ?? 3} scheduled in ${delayMs / 1000}s`,
      failedTask.assignedAgent ?? undefined,
    )
  } else {
    await Promise.all([
      prisma.task.update({
        where: { id: taskId },
        data: { status: 'failed', metadata: { ...failMeta, remediation_attempts: remediationAttempts } as object },
      }).catch(() => {}),
      logTaskEvent(taskId, 'failed', errMsg, failedTask?.assignedAgent ?? undefined),
    ])
    if (failedTask?.assignedAgent) {
      await postToFeed(failedTask.assignedAgent, `❌ Failed: **${failedTask.title}**\n\n${errMsg}`, taskId).catch(() => {})
    }
    notify({ type: 'task_failed', taskId, taskTitle: failedTask?.title ?? taskId, agentId: failedTask?.assignedAgent ?? '', agentName: '', error: errMsg }).catch(() => {})
    await writeTaskOutcome({
      title:           failedTask?.title ?? taskId,
      description:     failedTask?.description ?? null,
      status:         'failed',
      outcomeSummary: `Failed after ${remediationAttempts} attempt(s).`,
      errorMessage:    errMsg,
    })
    await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})
  }
}
