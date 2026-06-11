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
import { constantTimeCompare, isWithinReplayWindow } from '@/lib/security/webhook-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Allowlist for the `type` field — prevents attacker-controlled strings from
// polluting the event taxonomy or injecting unexpected values into correlation rules.
const ALLOWED_EVENT_TYPES = new Set([
  'auth_failure', 'crowdsec_block', 'connection_refused', 'k8s_warning',
  'anomaly', 'malware', 'privilege_escalation', 'data_exfil',
  'tool_execution', 'tool_denied', 'agent_heartbeat',
])

const MAX_STRING_LEN = 1000

function sanitizeString(v: unknown, maxLen = MAX_STRING_LEN): string {
  return String(v ?? '').slice(0, maxLen)
}

export async function POST(req: NextRequest) {
  // Auth: verify trusted internal secret
  const secret = req.headers.get('x-gateway-secret')
  if (!constantTimeCompare(secret ?? '', process.env.GATEWAY_AUDIT_SECRET ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Replay protection — reject requests with stale or missing timestamps.
  // Uses the same 5-minute window as other webhook endpoints.
  if (!isWithinReplayWindow(req.headers.get('x-timestamp'))) {
    return NextResponse.json({ error: 'Timestamp missing or outside replay window' }, { status: 400 })
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

    const rawType = String(e.type ?? '')
    const type = ALLOWED_EVENT_TYPES.has(rawType) ? rawType : 'unknown'
    // Clamp severity to [0, 100] — attacker-supplied value could be MAX_SAFE_INTEGER
    const severity = typeof e.severity === 'number' ? Math.max(0, Math.min(100, Math.round(e.severity))) : 0
    const source = 'gateway_audit' // always override — never trust caller-supplied source
    const title = sanitizeString(e.title ?? `${type} event`)
    const description = typeof e.description === 'string' ? sanitizeString(e.description) : null
    // Strip rawEvent to a shallow safe copy — no deeply nested attacker-controlled data
    const rawEvent: Record<string, unknown> = {}
    if (typeof e.rawEvent === 'object' && e.rawEvent !== null) {
      for (const [k, v] of Object.entries(e.rawEvent as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          rawEvent[k.slice(0, 64)] = typeof v === 'string' ? sanitizeString(v, 256) : v
        }
      }
    }
    const agent = sanitizeString(e.agent ?? 'unknown', 128)
    const toolName = sanitizeString(e.toolName ?? 'unknown', 128)

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
        rawEvent: JSON.parse(JSON.stringify(rawEvent)),
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
