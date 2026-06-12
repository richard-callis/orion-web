import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createHmac, timingSafeEqual } from 'crypto'

const MAX_VAR_LENGTH = 200

// ---------------------------------------------------------------------------
// Template interpolation — replaces {{key}} with vars[key]
// ---------------------------------------------------------------------------
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key] ?? `{{${key}}}`
    // Cap each substituted value to prevent prompt injection via webhook payloads
    return val.length > MAX_VAR_LENGTH ? val.slice(0, MAX_VAR_LENGTH) + '[…]' : val
  })
}

// ---------------------------------------------------------------------------
// Signature verification helpers
// ---------------------------------------------------------------------------
function verifyGitHub(rawBody: string, secret: string, sigHeader: string | null): boolean {
  if (!sigHeader) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  try {
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))
  } catch {
    return false
  }
}

function verifySecretHeader(secret: string, header: string | null): boolean {
  if (!header) return false
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(secret))
  } catch {
    return false
  }
}

function verifyBearerToken(secret: string, authHeader: string | null): boolean {
  if (!authHeader) return false
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  try {
    return timingSafeEqual(Buffer.from(match[1]), Buffer.from(secret))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Payload parsers — returns template variables for each source type
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGitHub(body: any): Record<string, string> {
  const vars: Record<string, string> = { event: 'push' }
  if (body.repository?.name) vars.repo = body.repository.name
  if (body.ref) vars.branch = (body.ref as string).replace(/^refs\/heads\//, '')
  if (body.pusher?.name) vars.pusher = body.pusher.name
  if (body.head_commit?.message) vars.commit = body.head_commit.message
  return vars
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePrometheus(body: any): Record<string, string> {
  const vars: Record<string, string> = { event: 'alert' }
  const firstAlert = Array.isArray(body.alerts) ? body.alerts[0] : null
  if (firstAlert) {
    if (firstAlert.labels?.alertname) vars.alert    = firstAlert.labels.alertname
    if (firstAlert.labels?.severity)  vars.severity = firstAlert.labels.severity
    if (firstAlert.status)            vars.status   = firstAlert.status
  }
  return vars
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCustom(body: any): Record<string, string> {
  const vars: Record<string, string> = { event: 'custom' }
  try {
    vars.payload = JSON.stringify(body)
  } catch {
    vars.payload = String(body)
  }
  return vars
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/[triggerId]
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params

  const trigger = await prisma.webhookTrigger.findUnique({
    where: { id: triggerId },
    include: { agent: { select: { id: true } } },
  })

  if (!trigger || !trigger.enabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Read raw body for HMAC computation
  const rawBody = await req.text()

  // Verify signature based on source
  let verified = false
  const source = trigger.source

  if (source === 'github') {
    verified = verifyGitHub(rawBody, trigger.secret, req.headers.get('x-hub-signature-256'))
  } else if (source === 'prometheus' || source === 'alertmanager') {
    verified = verifySecretHeader(trigger.secret, req.headers.get('x-webhook-secret'))
  } else {
    // custom: accept X-Webhook-Secret or Authorization: Bearer <secret>
    verified =
      verifySecretHeader(trigger.secret, req.headers.get('x-webhook-secret')) ||
      verifyBearerToken(trigger.secret, req.headers.get('authorization'))
  }

  if (!verified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Parse payload
  let parsedBody: unknown = {}
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    parsedBody = {}
  }

  let vars: Record<string, string>
  if (source === 'github') {
    vars = parseGitHub(parsedBody)
  } else if (source === 'prometheus' || source === 'alertmanager') {
    vars = parsePrometheus(parsedBody)
  } else {
    vars = parseCustom(parsedBody)
  }

  // Interpolate templates
  const title = interpolate(trigger.taskTitle, vars)
  const description = trigger.taskDesc ? interpolate(trigger.taskDesc, vars) : null

  // Create the task
  const task = await prisma.task.create({
    data: {
      title,
      description,
      status:       'pending',
      priority:     'medium',
      assignedAgent: trigger.agent.id,
      createdBy:    'webhook',
    } as never,
  })

  await Promise.all([
    prisma.webhookTrigger.update({
      where: { id: triggerId },
      data: { lastFiredAt: new Date(), fireCount: { increment: 1 } },
    }),
    prisma.jobRun.create({
      data: {
        source:     'webhook',
        sourceId:   triggerId,
        sourceName: trigger.name,
        agentId:    trigger.agent.id,
        taskId:     task.id,
        status:     'running',
      },
    }),
  ])

  return NextResponse.json({ ok: true, taskId: task.id })
}
