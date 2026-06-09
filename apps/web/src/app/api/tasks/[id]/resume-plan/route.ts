import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

/**
 * POST /api/tasks/:id/resume-plan
 *
 * Approves a task that paused at plan-before-execute (status
 * 'pending_validation'). Flips it back to 'pending' and records
 * metadata.planApproved = true so the worker skips re-planning and executes
 * the stored plan directly.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const task = await prisma.task.findUnique({ where: { id: params.id } })
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, task.createdBy)

  if (task.status !== 'pending_validation') {
    return NextResponse.json(
      { error: `Task is not awaiting plan approval (status: ${task.status})` },
      { status: 400 }
    )
  }

  const meta = (task.metadata ?? {}) as Record<string, unknown>
  const planContent = (meta.planContent as string | undefined) ?? null
  const approvedBy = caller?.id ?? 'gateway'

  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: 'pending',
      // Re-arm the retry gate so the poll loop picks it up immediately.
      nextRetryAt: null,
      planApprovedBy: approvedBy,
      planApprovedAt: new Date(),
      // Persist the approved plan text if the task didn't already have one.
      ...(!task.plan && planContent ? { plan: planContent } : {}),
      metadata: { ...meta, planApproved: true } as object,
    },
  })

  await prisma.taskEvent.create({
    data: {
      taskId: task.id,
      eventType: 'plan_approved',
      content: `Plan approved by ${approvedBy} — resuming execution.`,
      agentId: null,
    },
  })

  return NextResponse.json({ ok: true, id: task.id, status: 'pending' })
}
