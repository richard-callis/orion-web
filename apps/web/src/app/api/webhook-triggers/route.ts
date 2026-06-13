import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, CreateWebhookTriggerSchema } from '@/lib/validate'
import { encrypt } from '@/lib/encryption'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const triggers = await prisma.webhookTrigger.findMany({
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } } },
  })
  return NextResponse.json(triggers)
}

export async function POST(req: NextRequest) {
  let adminUser
  try { adminUser = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const parsed = await parseBodyOrError(req, CreateWebhookTriggerSchema)
  if ('error' in parsed) return parsed.error
  const { data } = parsed

  const agent = await prisma.agent.findUnique({ where: { id: data.agentId }, select: { id: true } })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const secret = randomBytes(32).toString('hex')
  const secretToStore = process.env.ORION_ENCRYPTION_KEY ? encrypt(secret) : secret
  const trigger = await prisma.webhookTrigger.create({
    data: {
      name:      data.name,
      agentId:   data.agentId,
      source:    data.source,
      taskTitle: data.taskTitle,
      taskDesc:  data.taskDesc ?? null,
      enabled:   data.enabled,
      secret:    secretToStore,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  // SOC2: audit webhook trigger creation
  logAudit({
    userId: adminUser.id,
    action: 'webhook_trigger_create',
    target: `webhook_trigger:${trigger.id}`,
    detail: { name: trigger.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  // Return the secret in the creation response — this is the only time the full secret is shown
  return NextResponse.json({ ...trigger, secret }, { status: 201 })
}
