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
 *
 * Body (optional JSON):
 *   { blockedSteps?: number[] }  — zero-based indices of plan steps to skip.
 *     When provided, the worker injects a note telling the agent to skip these
 *     steps before executing the rest of the approved plan.
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

  // Parse optional blockedSteps from request body
  let blockedSteps: number[] = []
  try {
    const body = await req.json().catch(() => ({}))
    if (Array.isArray(body?.blockedSteps)) {
      blockedSteps = body.blockedSteps.filter((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    }
  } catch { /* no body — treat as full approval */ }

  const meta = (task.metadata ?? {}) as Record<string, unknown>
  const planContent = (meta.planContent as string | undefined) ?? null
  const planSteps = (meta.planSteps as string[] | undefined) ?? []
  const approvedBy = caller?.id ?? 'gateway'

  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: 'pending',
      nextRetryAt: null,
      planApprovedBy: approvedBy,
      planApprovedAt: new Date(),
      ...(!task.plan && planContent ? { plan: planContent } : {}),
      metadata: { ...meta, planApproved: true, blockedSteps } as object,
    },
  })

  const blockedNote = blockedSteps.length > 0
    ? ` Blocked steps: ${blockedSteps.map(i => `#${i + 1} (${planSteps[i] ?? '?'})`).join(', ')}.`
    : ''

  await prisma.taskEvent.create({
    data: {
      taskId: task.id,
      eventType: 'plan_approved',
      content: `Plan approved by ${approvedBy} — resuming execution.${blockedNote}`,
      agentId: null,
    },
  })

  return NextResponse.json({ ok: true, id: task.id, status: 'pending', blockedSteps })
}
