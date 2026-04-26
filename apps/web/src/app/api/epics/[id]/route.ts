import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseBodyOrError, UpdateEpicSchema } from '@/lib/validate'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const epic = await prisma.epic.findUnique({
    where: { id: params.id },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })
  if (!epic) return new NextResponse(null, { status: 404 })
  return NextResponse.json(epic)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.epic.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateEpicSchema)
  if ('error' in result) return result.error

  const { data: validatedData } = result
  const data: Record<string, unknown> = {}
  if (validatedData.title       !== undefined) data.title       = validatedData.title
  if (validatedData.description !== undefined) data.description = validatedData.description
  if (validatedData.plan        !== undefined) data.plan        = validatedData.plan
  if (validatedData.status      !== undefined) data.status      = validatedData.status
  const epic = await prisma.epic.update({ where: { id: params.id }, data })
  return NextResponse.json(epic)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.epic.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  await prisma.epic.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
