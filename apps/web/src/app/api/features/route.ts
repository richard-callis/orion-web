import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, CreateFeatureSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const epicId = searchParams.get('epicId')
  const features = await prisma.feature.findMany({
    where: epicId ? { epicId } : undefined,
    orderBy: { createdAt: 'asc' },
    include: { epic: true, _count: { select: { tasks: true } } },
  })
  return NextResponse.json(features)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateFeatureSchema)
  if ('error' in result) return result.error

  const { data } = result

  const feature = await prisma.feature.create({
    data: {
      title:       data.title,
      description: data.description ?? null,
      status:      data.status,
      createdBy:   caller?.id ?? 'gateway',
      ...(data.epicId ? { epicId: data.epicId } : {}),
    } as any,
    include: { _count: { select: { tasks: true } } },
  })

  // Auto-create a feature chat room and add any already-assigned agents
  const room = await prisma.chatRoom.create({
    data: {
      name: feature.title,
      type: 'feature',
      featureId: feature.id,
      ...(data.epicId ? { epicId: data.epicId } : {}),
      createdBy: caller?.id ?? 'system',
      ...(caller ? { members: { create: [{ userId: caller.id, role: 'lead' }] } } : {}),
    },
  })

  // Add any agents already assigned to tasks in this feature
  const assignedAgents = await prisma.task.findMany({
    where: { featureId: feature.id, assignedAgent: { not: null } },
    select: { assignedAgent: true },
    distinct: ['assignedAgent'],
  })
  for (const { assignedAgent } of assignedAgents) {
    if (!assignedAgent) continue
    await prisma.chatRoomMember.upsert({
      where: { roomId_agentId: { roomId: room.id, agentId: assignedAgent } },
      create: { roomId: room.id, agentId: assignedAgent, role: 'member' },
      update: {},
    })
  }

  return NextResponse.json(feature, { status: 201 })
}
