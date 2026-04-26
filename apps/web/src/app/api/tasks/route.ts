import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, CreateTaskSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const status        = searchParams.get('status')        // pending|in_progress|completed|blocked
  const featureId     = searchParams.get('featureId')
  const assignedAgent = searchParams.get('assignedAgent')
  const priority      = searchParams.get('priority')

  const where: Record<string, unknown> = {}
  if (status)        where.status        = status
  if (featureId)     where.featureId     = featureId
  if (assignedAgent) where.assignedAgent = assignedAgent
  if (priority)      where.priority      = priority

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: { agent: true, feature: { include: { epic: true } } },
  })
  return NextResponse.json(tasks)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateTaskSchema)
  if ('error' in result) return result.error

  const { data } = result

  const task = await prisma.task.create({
    data: {
      title:       data.title,
      description: data.description ?? null,
      priority:    data.priority ?? 'medium',
      featureId:   data.featureId ?? null,
      ...(data.assignedAgentId && { assignedAgent: data.assignedAgentId }),
      assignedUserId: data.assignedUserId ?? null,
      createdBy:    caller?.id ?? 'gateway',
    } as any,
    include: { agent: true },
  })
  return NextResponse.json(task, { status: 201 })
}
