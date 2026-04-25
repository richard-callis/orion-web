import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const task = await prisma.task.findUnique({
    where: { id: params.id },
    include: {
      agent:        true,
      assignedUser: true,
      feature:      { include: { epic: true } },
      events:       { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!task) return new NextResponse(null, { status: 404 })
  return NextResponse.json(task)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.task.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.status          !== undefined) data.status          = body.status
  if (body.title           !== undefined) data.title           = body.title
  if (body.description     !== undefined) data.description     = body.description
  if (body.plan            !== undefined) data.plan            = body.plan
  if (body.featureId       !== undefined) data.featureId       = body.featureId
  if (body.priority        !== undefined) data.priority        = body.priority
  if (body.assignedAgent   !== undefined) data.assignedAgent   = body.assignedAgent   || null
  if (body.assignedUserId  !== undefined) data.assignedUserId  = body.assignedUserId  || null
  const task = await prisma.task.update({
    where: { id: params.id },
    data,
    include: { agent: true, assignedUser: true },
  })
  return NextResponse.json(task)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // Check ownership
  const existing = await prisma.task.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  await prisma.task.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
