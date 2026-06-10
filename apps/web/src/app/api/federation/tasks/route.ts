/**
 * POST /api/federation/tasks
 *
 * Accept a task dispatched from a hub instance. Creates the task locally
 * in this spoke's DB and marks it pending for the local worker to pick up.
 *
 * Auth: Bearer <federationToken>
 * Body: { taskId, title, description?, agentId?, metadata? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

async function validateFederationToken(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice(7)

  const env = await prisma.environment.findFirst({
    where: { federationToken: token },
    select: { id: true },
  })
  return env !== null
}

export async function POST(req: NextRequest) {
  if (!(await validateFederationToken(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    taskId?: string
    title?: string
    description?: string | null
    agentId?: string | null
    metadata?: Record<string, unknown> | null
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.taskId || !body.title) {
    return NextResponse.json({ error: 'taskId and title are required' }, { status: 400 })
  }

  // Verify the agent exists on this spoke (if provided)
  if (body.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: body.agentId },
      select: { id: true },
    })
    if (!agent) {
      return NextResponse.json(
        { error: `Agent ${body.agentId} not found on this spoke` },
        { status: 422 },
      )
    }
  }

  // Create or upsert the task — the taskId is supplied by the hub so it can
  // correlate status lookups by the same ID.
  const task = await prisma.task.upsert({
    where: { id: body.taskId },
    create: {
      id: body.taskId,
      title: body.title,
      description: body.description ?? null,
      assignedAgent: body.agentId ?? null,
      createdBy: 'federation',
      status: 'pending',
      metadata: {
        ...(body.metadata as object | null ?? {}),
        federatedFrom: 'hub',
      } as object,
    },
    update: {
      status: 'pending',
    },
    select: { id: true, status: true },
  })

  // Acknowledge the dispatch if a FederatedDispatch record exists for this task
  await prisma.federatedDispatch
    .updateMany({
      where: { taskId: body.taskId, status: 'dispatched' },
      data: { status: 'acknowledged', acknowledgedAt: new Date() },
    })
    .catch(() => {})

  return NextResponse.json({ accepted: true, taskId: task.id }, { status: 201 })
}
