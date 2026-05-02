import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseBodyOrError, UpdateTaskSchema } from '@/lib/validate'
import { handlePlanPatch } from '@/lib/plan-patch'

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
  return handlePlanPatch('task', params.id, req)
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
