import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, requireWriteAccess } from '@/lib/auth'
import { parseBodyOrError, CreateTaskSchema } from '@/lib/validate'
import { z } from 'zod'

const TaskQuerySchema = z.object({
  status:        z.enum(['pending', 'in_progress', 'pending_validation', 'done', 'failed', 'blocked']).optional(),
  featureId:     z.string().max(100).optional(),
  assignedAgent: z.string().max(100).optional(),
  priority:      z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  limit:         z.coerce.number().int().min(1).max(1000).default(500),
})

export async function GET(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null
  const { searchParams } = new URL(req.url)

  const parsed = TaskQuerySchema.safeParse({
    status:        searchParams.get('status') ?? undefined,
    featureId:     searchParams.get('featureId') ?? undefined,
    assignedAgent: searchParams.get('assignedAgent') ?? undefined,
    priority:      searchParams.get('priority') ?? undefined,
    limit:         searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', issues: parsed.error.issues }, { status: 400 })
  }
  const { status, featureId, assignedAgent, priority, limit } = parsed.data

  const where: Record<string, unknown> = {}
  if (status)        where.status        = status
  if (featureId)     where.featureId     = featureId
  if (assignedAgent) where.assignedAgent = assignedAgent
  if (priority)      where.priority      = priority

  // SOC2: Non-admin users only see tasks they created or are assigned to
  if (!isService && caller && caller.role !== 'admin') {
    where.OR = [
      { createdBy: caller.id },
      { assignedUserId: caller.id },
    ]
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: { agent: true, feature: { include: { epic: true } } },
  })
  return NextResponse.json(tasks)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // SOC2: readonly users may not create tasks
  if (!isService && caller && caller.role === 'readonly') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateTaskSchema)
  if ('error' in result) return result.error

  const { data } = result

  const task = await prisma.task.create({
    data: {
      title:          data.title,
      description:    data.description   ?? null,
      priority:       data.priority      ?? 'medium',
      featureId:      data.featureId     ?? null,
      assignedAgent:  data.assignedAgentId ?? null,
      assignedUserId: data.assignedUserId  ?? null,
      createdBy:      caller?.id           ?? 'gateway',
    },
    include: { agent: true },
  })
  return NextResponse.json(task, { status: 201 })
}
