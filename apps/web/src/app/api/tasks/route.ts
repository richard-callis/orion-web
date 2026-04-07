import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
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
  const body = await req.json()
  const task = await prisma.task.create({
    data: {
      title:         body.title,
      description:   body.description ?? null,
      priority:      body.priority ?? 'medium',
      featureId:     body.featureId ?? null,
      assignedAgent: body.assignedAgent ?? null,
      createdBy:     body.createdBy ?? 'admin',
    },
    include: { agent: true },
  })
  return NextResponse.json(task, { status: 201 })
}
