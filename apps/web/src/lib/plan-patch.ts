import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function handlePlanPatch(
  model: 'task' | 'epic' | 'feature',
  id: string,
  req: NextRequest,
): Promise<NextResponse> {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const existing = await (prisma[model] as any).findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.plan           !== undefined) data.plan           = body.plan
  if (body.planApprovedBy !== undefined) data.planApprovedBy = body.planApprovedBy
  if (body.planApprovedAt !== undefined) data.planApprovedAt = body.planApprovedAt ? new Date(body.planApprovedAt as string) : null
  if (model === 'task' && body.planProgress !== undefined) {
    data.planProgress = body.planProgress !== null ? Number(body.planProgress) : null
  }

  if (body.plan !== undefined) {
    await prisma.auditLog.create({
      data: {
        userId: req.headers.get('x-user-id') ?? 'system',
        action: 'plan.updated',
        target: `${model}:${id}`,
        detail: { field: 'plan', entityType: model, entityId: id },
      },
    }).catch(() => {})
  }

  const result = await (prisma[model] as any).update({ where: { id }, data })
  return NextResponse.json(result)
}
