/**
 * POST /api/monitoring/security/events
 *
 * Accepts security audit events from trusted internal services (gateway,
 * host-agent Vector shipper). Creates SecurityEvent rows for correlation
 * and incident generation.
 *
 * Auth: X-Gateway-Secret header matching process.env.GATEWAY_AUDIT_SECRET
 * (same secret used by existing gateway auth for simplicity).
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { constantTimeCompare } from '@/lib/security/webhook-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  // Auth: verify trusted internal secret
  const secret = req.headers.get('x-gateway-secret')
  if (!constantTimeCompare(secret ?? '', process.env.GATEWAY_AUDIT_SECRET ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Accept both single events and batched events
  const events = Array.isArray(body) ? body : [body]

  const now = new Date()
  const ids: string[] = []

  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue
    const e = raw as Record<string, unknown>

    const type = String(e.type ?? '')
    const severity = typeof e.severity === 'number' ? e.severity : 0
    const source = String(e.source ?? 'gateway_audit')
    const title = String(e.title ?? `${type} event`)
    const description = typeof e.description === 'string' ? e.description : null
    const rawEvent = typeof e.rawEvent === 'object' && e.rawEvent !== null ? e.rawEvent as Record<string, unknown> : {}
    const agent = typeof e.agent === 'string' ? e.agent : 'unknown'
    const toolName = typeof e.toolName === 'string' ? e.toolName : 'unknown'

    const eventId = crypto.randomUUID()
    const dedupKey = crypto.createHash('sha256').update(`${source}:${toolName}:${agent}:${now.toISOString().slice(0, 19)}`).digest('hex')

    await prisma.securityEvent.create({
      data: {
        id: eventId,
        environmentId: null,
        type,
        source,
        severity,
        title,
        description,
        rawEvent: rawEvent as any,
        dedupKey,
        firstSeen: now,
        lastSeen: now,
        createdAt: now,
      },
    })
    ids.push(eventId)
  }

  await prisma.sourceHealth.upsert({
    where: { source: 'gateway_audit' },
    update: { lastSeenAt: now },
    create: {
      source: 'gateway_audit',
      lastSeenAt: now,
      lastWatermark: null,
      staleAfterMs: 3600 * 1000, // 1 hour — gateway_audit only fires on writes
    },
  })

  return NextResponse.json({ accepted: ids.length, ids })
}
