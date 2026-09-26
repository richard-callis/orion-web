import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify, isExecutorServiceCall } from '@/lib/auth'
import {
  assertCanReview,
  recordReviewDecision,
  auditReview,
  ExecutionReviewError,
} from '@/lib/execution-review'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let caller
  try { caller = await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const isService = caller === null
  try {
    const execution = await prisma.toolExecution.findUnique({
      where: { id: (await params).id },
    })

    if (!execution) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }

    try {
      await assertCanModify(caller, isService, execution.actorId ?? '')
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json(execution)
  } catch (error) {
    console.error('Error getting execution:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // SOC2 [C2]: execution records are updated only by the executor service. Sessions
  // are rejected — previously any session whose id matched actorId could PATCH
  // reviewDecision: 'approved' on its own request. Human decisions arrive either via
  // POST /api/executions/[id]/review or forwarded by the executor's review endpoint
  // with a reviewerId, which is re-validated here (admin, not the actor, still pending).
  if (!isExecutorServiceCall(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const existing = await prisma.toolExecution.findUnique({
      where: { id: (await params).id },
    })
    if (!existing) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }

    const body = await req.json()

    const {
      status,
      riskTier,
      exitCode,
      output,
      durationMs,
      reviewerId,
      reviewDecision,
      expiresAt,
      completedAt,
    } = body

    if (reviewDecision !== undefined && reviewDecision !== 'approved' && reviewDecision !== 'denied') {
      return NextResponse.json({ error: 'reviewDecision must be "approved" or "denied"' }, { status: 400 })
    }
    if (reviewerId !== undefined && reviewDecision === undefined) {
      return NextResponse.json({ error: 'reviewerId requires reviewDecision' }, { status: 400 })
    }

    if (reviewDecision !== undefined) {
      // A decision is a compare-and-set on the still-pending row, so a late TTL
      // auto-deny can never overwrite an approval (or vice versa).
      if (reviewDecision === 'approved' || reviewerId !== undefined) {
        // Human decision forwarded by the executor: the reviewer must be a real
        // user. Approvals additionally require an admin who is not the actor.
        if (typeof reviewerId !== 'string' || !reviewerId) {
          return NextResponse.json({ error: 'Approvals require a reviewerId' }, { status: 400 })
        }
        const reviewer = await prisma.user.findUnique({
          where: { id: reviewerId },
          select: { id: true, role: true, active: true },
        })
        if (!reviewer) {
          return NextResponse.json({ error: 'Reviewer not found' }, { status: 403 })
        }
        if (reviewDecision === 'approved') {
          assertCanReview(existing, reviewer)
        }
        await recordReviewDecision(existing.id, reviewer.id, reviewDecision)
        await auditReview(existing, reviewer.id, reviewDecision, typeof body.reason === 'string' ? body.reason : undefined)
      } else {
        // TTL auto-deny by the executor (no human reviewer).
        const now = new Date()
        const { count } = await prisma.toolExecution.updateMany({
          where: { id: existing.id, status: 'pending', reviewDecision: null },
          data: {
            status: 'denied',
            reviewDecision: 'denied',
            reviewedAt: now,
            completedAt: now,
          },
        })
        if (count !== 1) {
          return NextResponse.json({ error: 'Execution is no longer pending' }, { status: 409 })
        }
      }
      const reviewed = await prisma.toolExecution.findUnique({ where: { id: existing.id } })
      return NextResponse.json(reviewed)
    }

    // Build update object with only provided fields
    const updateData: any = {}
    if (status !== undefined) updateData.status = status
    if (riskTier !== undefined) updateData.riskTier = riskTier
    if (exitCode !== undefined) updateData.exitCode = exitCode
    if (output !== undefined) updateData.output = output
    if (durationMs !== undefined) updateData.durationMs = durationMs
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt
    if (completedAt !== undefined) updateData.completedAt = completedAt

    const execution = await prisma.toolExecution.update({
      where: { id: (await params).id },
      data: updateData,
    })

    return NextResponse.json(execution)
  } catch (error: any) {
    if (error instanceof ExecutionReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (error?.code === 'P2025') {
      // Not found
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }
    console.error('Error updating execution:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
