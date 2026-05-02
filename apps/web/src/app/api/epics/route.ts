import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, CreateEpicSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const epics = await prisma.epic.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { features: { include: { _count: { select: { tasks: true } } }, orderBy: { createdAt: 'asc' } } },
  })
  return NextResponse.json(epics)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateEpicSchema)
  if ('error' in result) return result.error

  const { data } = result

  const epic = await prisma.epic.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      plan: data.plan,
      status: data.status,
      createdBy: caller?.id ?? 'gateway',
    },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })

  // Auto-create a planning chat room for this epic
  await prisma.chatRoom.create({
    data: {
      name: `${epic.title} — Planning`,
      type: 'planning',
      epicId: epic.id,
      createdBy: caller?.id ?? 'system',
      ...(caller ? { members: { create: [{ userId: caller.id, role: 'lead' }] } } : {}),
    },
  })

  return NextResponse.json(epic, { status: 201 })
}
