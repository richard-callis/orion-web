/**
 * Human review of pending executor tool executions.
 *
 * SOC2 [C2/H1]: the executor polls the ToolExecution row and runs the command once
 * `reviewDecision === 'approved'` (and, since the executor hardening, only when a
 * `reviewerId` is present). Every path that records an approval must therefore
 * enforce the same invariants, implemented once here in `assertCanReview`:
 *   - the reviewer is an active human admin (never an agent, never a service token)
 *   - the reviewer is not the actor that requested the execution (no self-approval)
 *   - the row is still pending, unreviewed, and not expired
 *
 * Writers:
 *   - POST /api/executions/[id]/review → reviewExecution() (admin session, DB write)
 *   - approve_execution / deny_execution tools → assertCanReview() preflight, then the
 *     executor's /executions/:id/review endpoint with reviewerId
 *   - PATCH /api/executions/[id] (executor token) → assertCanReview() on the reviewer
 *     the executor forwards, before the compare-and-set write
 *
 * Writes are a compare-and-set on (status='pending', reviewDecision=null), so two
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

type Reviewer = Pick<AppUser, 'id' | 'role'> & { active?: boolean }

/** Look up an execution by ToolExecution.id (cuid) or executionId (client UUID shown in room notifications). */
export async function findExecutionForReview(id: string): Promise<ToolExecution> {
  const execution = await prisma.toolExecution.findFirst({
    where: { OR: [{ id }, { executionId: id }] },
  })
  if (!execution) throw new ExecutionReviewError('Execution not found', 404)
  return execution
}

/** Throws ExecutionReviewError unless `reviewer` may record a decision on `execution` now. */
export function assertCanReview(
  execution: Pick<ToolExecution, 'actorId' | 'status' | 'reviewDecision' | 'expiresAt'>,
  reviewer: Reviewer,
): void {
  if (reviewer.active === false) {
    throw new ExecutionReviewError('Reviewer account is inactive', 403)
  }
  if (reviewer.role !== 'admin') {
    throw new ExecutionReviewError('Only admins may review executions', 403)
  }
  if (execution.actorId === reviewer.id) {
    throw new ExecutionReviewError('You cannot review an execution you requested', 403)
  }
  if (execution.status !== 'pending' || execution.reviewDecision) {
    throw new ExecutionReviewError(`Execution is not awaiting review (status: ${execution.status})`, 409)
  }
  if (execution.expiresAt && execution.expiresAt <= new Date()) {
    throw new ExecutionReviewError('Execution review window has expired', 409)
  }
}

/**
 * Compare-and-set the decision onto a still-pending row. `extra` carries any other
 * executor-supplied fields (e.g. status/completedAt on a denial).
 */
export async function recordReviewDecision(
  executionId: string,
  reviewerId: string,
  decision: ReviewDecision,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date()
  const { count } = await prisma.toolExecution.updateMany({
    where: { id: executionId, status: 'pending', reviewDecision: null },
    data: {
      ...extra,
      reviewerId,
      reviewDecision: decision,
      reviewedAt: now,
      ...(decision === 'denied' ? { status: 'denied', completedAt: now } : {}),
    },
  })
  if (count !== 1) {
    throw new ExecutionReviewError('Execution was reviewed concurrently', 409)
  }
}

export async function auditReview(
  execution: Pick<ToolExecution, 'id' | 'tool' | 'actorId'>,
  reviewerId: string,
  decision: ReviewDecision,
  reason: string | undefined,
): Promise<void> {
  await logAudit({
    userId: reviewerId,
    action: decision === 'approved' ? 'execution_approve' : 'execution_deny',
    target: `execution:${execution.id}`,
    detail: { tool: execution.tool, actorId: execution.actorId, reason: reason ?? null },
  })
}

/** Admin-session review: validate and write the decision directly to the row. */
export async function reviewExecution(params: {
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
  if (reviewer.totpEnabled && !reviewer.mfaVerified) {
    throw new ExecutionReviewError('MFA verification required', 403)
  }

  const execution = await findExecutionForReview(id)
  assertCanReview(execution, reviewer)
  await recordReviewDecision(execution.id, reviewer.id, decision)
  await auditReview(execution, reviewer.id, decision, reason)

  const updated = await prisma.toolExecution.findUnique({ where: { id: execution.id } })
  return updated ?? execution
}
