import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'

export async function GET() {
  const triggers = await prisma.webhookTrigger.findMany({
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } } },
  })
  return NextResponse.json(triggers)
}

export async function POST(req: NextRequest) {
  let body: {
    name: string
    agentId: string
    source?: string
    taskTitle: string
    taskDesc?: string
    enabled?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.name || !body.agentId || !body.taskTitle) {
    return NextResponse.json(
      { error: 'name, agentId, and taskTitle are required' },
      { status: 400 }
    )
  }

  const agent = await prisma.agent.findUnique({ where: { id: body.agentId } })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const secret = randomBytes(32).toString('hex')

  const trigger = await prisma.webhookTrigger.create({
    data: {
      name:      body.name,
      agentId:   body.agentId,
      source:    body.source ?? 'custom',
      taskTitle: body.taskTitle,
      taskDesc:  body.taskDesc ?? null,
      enabled:   body.enabled ?? true,
      secret,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  // Return the secret in the creation response — this is the only time the full secret is shown
  return NextResponse.json({ ...trigger, secret }, { status: 201 })
}
