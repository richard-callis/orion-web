import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseBodyOrError, UpdateFeatureSchema } from '@/lib/validate'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const feature = await prisma.feature.findUnique({
    where: { id: params.id },
    include: { _count: { select: { tasks: true } } },
  })
  if (!feature) return new NextResponse(null, { status: 404 })
  return NextResponse.json(feature)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.feature.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateFeatureSchema)
  if ('error' in result) return result.error

  const { data: validatedData } = result
  const data: Record<string, unknown> = {}
  if (validatedData.title       !== undefined) data.title       = validatedData.title
  if (validatedData.description !== undefined) data.description = validatedData.description
  if (validatedData.plan        !== undefined) data.plan        = validatedData.plan
  if (validatedData.status      !== undefined) data.status      = validatedData.status
  if (validatedData.epicId      !== undefined) data.epicId      = validatedData.epicId
  const feature = await prisma.feature.update({ where: { id: params.id }, data })
  return NextResponse.json(feature)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = params.id

  const existing = await prisma.feature.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.plan            !== undefined) data.plan            = body.plan
  if (body.planApprovedBy  !== undefined) data.planApprovedBy  = body.planApprovedBy
  if (body.planApprovedAt  !== undefined) data.planApprovedAt  = body.planApprovedAt ? new Date(body.planApprovedAt as string) : null

  if (body.plan !== undefined) {
    await prisma.auditLog.create({
      data: {
        userId: req.headers.get('x-user-id') ?? 'system',
        action: 'plan.updated',
        target: `feature:${id}`,
        detail: { field: 'plan', entityType: 'feature', entityId: id },
      },
    }).catch(() => {})
  }

  const feature = await prisma.feature.update({ where: { id }, data })
  return NextResponse.json(feature)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.feature.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  await prisma.feature.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
