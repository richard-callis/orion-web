import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseBodyOrError, UpdateTaskSchema } from '@/lib/validate'

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

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateTaskSchema)
  if ('error' in result) return result.error

  const { data } = result
  const dbData: Record<string, unknown> = {}
  if (data.status          !== undefined) dbData.status          = data.status
  if (data.title           !== undefined) dbData.title           = data.title
  if (data.description     !== undefined) dbData.description     = data.description
  if (data.plan            !== undefined) dbData.plan            = data.plan
  if (data.priority        !== undefined) dbData.priority        = data.priority
  if (data.assignedAgentId !== undefined) dbData.assignedAgentId = data.assignedAgentId || null
  if (data.assignedUserId  !== undefined) dbData.assignedUserId  = data.assignedUserId  || null
  const task = await prisma.task.update({
    where: { id: params.id },
    data: dbData,
    include: { agent: true, assignedUser: true },
  })

  // When an agent is assigned, add them to the feature's chat room (if one exists)
  if (data.assignedAgentId && existing.featureId) {
    const featureRoom = await prisma.chatRoom.findFirst({
      where: { featureId: existing.featureId, type: 'feature' },
      select: { id: true },
    })
    if (featureRoom) {
      await prisma.chatRoomMember.upsert({
        where: { roomId_agentId: { roomId: featureRoom.id, agentId: data.assignedAgentId as string } },
        create: { roomId: featureRoom.id, agentId: data.assignedAgentId as string, role: 'member' },
        update: {},
      })
    }
  }

  return NextResponse.json(task)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = params.id

  const existing = await prisma.task.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.plan            !== undefined) data.plan            = body.plan
  if (body.planProgress    !== undefined) data.planProgress    = body.planProgress !== null ? Number(body.planProgress) : null
  if (body.planApprovedBy  !== undefined) data.planApprovedBy  = body.planApprovedBy
  if (body.planApprovedAt  !== undefined) data.planApprovedAt  = body.planApprovedAt ? new Date(body.planApprovedAt as string) : null

  if (body.plan !== undefined) {
    await prisma.auditLog.create({
      data: {
        userId: req.headers.get('x-user-id') ?? 'system',
        action: 'plan.updated',
        target: `task:${id}`,
        detail: { field: 'plan', entityType: 'task', entityId: id },
      },
    }).catch(() => {})
  }

  const task = await prisma.task.update({ where: { id }, data })
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
