import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
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

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.task.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
