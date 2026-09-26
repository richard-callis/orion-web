/**
 * Human review of pending executor tool executions.
 *
 * SOC2 [C2/H1]: this is the ONLY path that may record an approve/deny decision on a
 * ToolExecution. The executor polls the row and runs the command once
 * `reviewDecision === 'approved'`, so the decision must come from:
 *   - an authenticated human admin session (never an agent, never a service token)
 *   - who is not the actor that requested the execution (no self-approval)
 *   - against a row that is still pending, unreviewed, and not expired
 *
 * The update is a compare-and-set on (status='pending', reviewDecision=null), so two
 * concurrent reviews cannot both win.
 */
import type { ToolExecution } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import type { AppUser } from '@/lib/auth'

export type ReviewDecision = 'approved' | 'denied'

export class ExecutionReviewError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'ExecutionReviewError'
  }
}

export async function reviewExecution(params: {
  /** ToolExecution.id (cuid) or ToolExecution.executionId (client UUID shown in room notifications) */
  id: string
  reviewer: AppUser
  decision: ReviewDecision
  reason: string
}): Promise<ToolExecution> {
  const { id, reviewer, decision, reason } = params

  if (decision !== 'approved' && decision !== 'denied') {
    throw new ExecutionReviewError('decision must be "approved" or "denied"', 400)
  }
  if (!reason?.trim()) {
    throw new ExecutionReviewError('reason is required', 400)
  }
  if (reviewer.role !== 'admin') {
    throw new ExecutionReviewError('Only admins may review executions', 403)
  }
  if (reviewer.totpEnabled && !reviewer.mfaVerified) {
    throw new ExecutionReviewError('MFA verification required', 403)
  }

  const execution = await prisma.toolExecution.findFirst({
    where: { OR: [{ id }, { executionId: id }] },
  })
  if (!execution) throw new ExecutionReviewError('Execution not found', 404)

  if (execution.actorId === reviewer.id) {
    throw new ExecutionReviewError('You cannot review an execution you requested', 403)
  }
  if (execution.status !== 'pending' || execution.reviewDecision) {
    throw new ExecutionReviewError(`Execution is not awaiting review (status: ${execution.status})`, 409)
  }
  const now = new Date()
  if (execution.expiresAt && execution.expiresAt <= now) {
    throw new ExecutionReviewError('Execution review window has expired', 409)
  }

  const { count } = await prisma.toolExecution.updateMany({
    where: { id: execution.id, status: 'pending', reviewDecision: null },
    data: {
      reviewerId: reviewer.id,
      reviewDecision: decision,
      reviewedAt: now,
      ...(decision === 'denied' ? { status: 'denied', completedAt: now } : {}),
    },
  })
  if (count !== 1) {
    throw new ExecutionReviewError('Execution was reviewed concurrently', 409)
  }

  await logAudit({
    userId: reviewer.id,
    action: decision === 'approved' ? 'execution_approve' : 'execution_deny',
    target: `execution:${execution.id}`,
    detail: { tool: execution.tool, actorId: execution.actorId, reason },
  })

  const updated = await prisma.toolExecution.findUnique({ where: { id: execution.id } })
  return updated ?? execution
}
