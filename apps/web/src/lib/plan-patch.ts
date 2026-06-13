import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

export async function handlePlanPatch(
  model: 'task' | 'epic' | 'feature',
  id: string,
  req: NextRequest,
): Promise<NextResponse> {
  // M5 fix: authenticate the caller and use their real id for the audit log.
  // Previously the route trusted x-user-id from the request header — forgeable.
  let caller: Awaited<ReturnType<typeof requireServiceAuth>>
  try {
    caller = await requireServiceAuth(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const isService = caller === null
  const auditUserId = caller?.id ?? 'gateway'

  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const existing = await (prisma[model] as any).findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // SOC2: verify the caller owns this record (or is admin/service)
  try {
    await assertCanModify(caller, isService, existing.createdBy)
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const data: Record<string, unknown> = {}
  if (body.plan !== undefined) data.plan = body.plan
  // SOC2: planApprovedBy and planApprovedAt must never be accepted from the
  // request body — doing so allows self-approval of any plan. If the plan is
  // being approved, set planApprovedBy server-side from the authenticated caller.
  if (body.planApproved === true) {
    data.planApprovedBy = caller?.id ?? null
    data.planApprovedAt = new Date()
  } else if (body.planApproved === false) {
    data.planApprovedBy = null
    data.planApprovedAt = null
  }
  if (model === 'task' && body.planProgress !== undefined) {
    data.planProgress = body.planProgress !== null ? Number(body.planProgress) : null
  }

  if (body.plan !== undefined) {
    await prisma.auditLog.create({
      data: {
        userId: auditUserId,
        action: 'plan.updated',
        target: `${model}:${id}`,
        detail: { field: 'plan', entityType: model, entityId: id },
      },
    }).catch(() => {})
  }

  const result = await (prisma[model] as any).update({ where: { id }, data })
  return NextResponse.json(result)
}
