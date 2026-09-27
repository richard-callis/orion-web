import { prisma } from '@/lib/db'
import { createRunner } from '@/lib/agent-runner'
import type { TaskRunContext } from '@/lib/agent-runner'
import { err } from './log'
import { logTaskEvent } from './db-helpers'

/**
 * Optionally spawns a lightweight reviewer agent after a task completes to
 * validate output quality. If the reviewer rejects the output, the task is
 * reopened to `pending` (or `failed` once retries are exhausted) so it gets
 * retried.
 *
 * Reviewer failures are non-fatal — any error is logged and ignored so the
 * task outcome is never affected.
 *
 * Returns `true` if the reviewer rejected the output and reopened/failed the
 * task, `false` otherwise (approved, skipped, or the check itself errored —
 * in which case we fall back to treating the task as approved, matching the
 * pre-existing non-fatal-error behavior).
 */
export async function runReviewerCheck(
  taskId: string,
  taskTitle: string,
  output: string,
  agentId: string,
  modelId: string,
): Promise<boolean> {
  if (output.trim().length === 0) return false

  try {
    await logTaskEvent(taskId, 'reviewer_start', 'Reviewer agent checking output quality', agentId)

    const reviewerSystemPrompt =
      'You are a quality reviewer for AI agent task outputs. Your ONLY job is to check if the task output is complete and sensible. Reply with exactly one of:\n' +
      '- APPROVED: <one-line reason>\n' +
      '- REJECTED: <one-line reason explaining what is missing or wrong>\n' +
      'Do not add any other text.'

    const ctx: TaskRunContext = {
      taskId,
      taskTitle,
      taskDescription: `Task: ${taskTitle}\n\nOutput to review:\n${output.slice(0, 3000)}`,
      taskPlan:        null,
      agentId,
      agentName:       'reviewer',
      systemPrompt:    reviewerSystemPrompt,
      modelId,
      gateway:         null,
    }

    const runner = createRunner(modelId)
    let reviewText = ''

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Reviewer timed out after 60s')), 60_000)
    )

    const runReview = async () => {
      for await (const event of runner.run(ctx)) {
        if (event.type === 'text') reviewText += event.content
        if (event.type === 'error') throw new Error(event.error)
      }
    }

    await Promise.race([runReview(), timeout])

    const verdict = reviewText.trim()
    if (verdict.startsWith('REJECTED:')) {
      const reason = verdict.slice('REJECTED:'.length).trim()
      await logTaskEvent(taskId, 'reviewer_rejected', reason, agentId)
      const current = await prisma.task.findUnique({ where: { id: taskId }, select: { retryCount: true } })
      const retryCount = (current?.retryCount ?? 0) + 1
      // Cap retries at 3 to prevent unbounded rejection loops
      const newStatus = retryCount >= 3 ? 'failed' : 'pending'
      await prisma.task.update({ where: { id: taskId }, data: { status: newStatus, retryCount } })
      return true
    } else {
      const reason = verdict.startsWith('APPROVED:') ? verdict.slice('APPROVED:'.length).trim() : verdict
      await logTaskEvent(taskId, 'reviewer_approved', reason || 'Output approved', agentId)
      return false
    }
  } catch (e) {
    err(`runReviewerCheck for task ${taskId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
