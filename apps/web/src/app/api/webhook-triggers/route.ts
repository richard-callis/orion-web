import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, CreateWebhookTriggerSchema } from '@/lib/validate'

async function guard() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET() {
  const deny = await guard(); if (deny) return deny
  const triggers = await prisma.webhookTrigger.findMany({
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } } },
  })
  return NextResponse.json(triggers)
}

export async function POST(req: NextRequest) {
  const deny = await guard(); if (deny) return deny
  const parsed = await parseBodyOrError(req, CreateWebhookTriggerSchema)
  if ('error' in parsed) return parsed.error
  const { data } = parsed

  const agent = await prisma.agent.findUnique({ where: { id: data.agentId }, select: { id: true } })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const secret = randomBytes(32).toString('hex')
  const trigger = await prisma.webhookTrigger.create({
    data: {
      name:      data.name,
      agentId:   data.agentId,
      source:    data.source,
      taskTitle: data.taskTitle,
      taskDesc:  data.taskDesc ?? null,
      enabled:   data.enabled,
      secret,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  // Return the secret in the creation response — this is the only time the full secret is shown
  return NextResponse.json({ ...trigger, secret }, { status: 201 })
}
