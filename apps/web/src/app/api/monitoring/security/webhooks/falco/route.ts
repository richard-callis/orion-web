/**
 * Falco ingest webhook endpoint (Phase 2).
 *
 * Receives security alerts from Falcosidekick (deployed alongside each
 * managed environment AND on the Orion host per the Phase 2 plan).
 *
 * Auth: bearer-token model. Falcosidekick's WEBHOOK_CUSTOMHEADERS supports
 * only static header values — it cannot compute a body HMAC. We therefore
 * verify a shared bearer token in X-Orion-Falco-Token via constant-time
 * compare. The deployment relies on TLS at the ingress for transport
 * confidentiality (Traefik). The honest auth model is documented in
 * SECURITY_NOTES.md and the Phase 2 PR7 deploy artifacts use this header.
 *
 * Replay protection: the Falco alert body carries a `time` field set by
 * Falco. We require it within 5 minutes of now() — gives a replay window
 * even without an HMAC-signed timestamp header.
 *
 * Environment scoping: every alert MUST carry an environmentId injected by
 * Falcosidekick's CUSTOMFIELDS at deploy time. The literal string "host"
 * identifies the Orion host's own Falco (per the Phase 1 amendment) and
 * uses the global SourceHealth table rather than EnvironmentSourceHealth
 * (which has a FK to Environment).
 *
 * Heartbeat handling: Falco's "Heartbeat" rule is a liveness ping. We bump
 * the appropriate source-health row and do NOT insert a SecurityEvent.
 *
 * Payload shape from Falcosidekick (singleton, not a batch):
 *   { rule, priority, output, output_fields, time, hostname }
 *
 * Unlike Phase 1's host-agent webhook (which batches), Falcosidekick
 * fires one POST per alert. Lower throughput and simpler to reason about.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  isLoopbackWebhookRequest,
  warnMissingWebhookSecret,
  checkWebhookBodySize,
  WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/security/webhook-auth'
import {
  falcoAlertSchema,
  isHeartbeat,
  normalizeFalcoAlert,
} from '@/lib/security/normalize/falco'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const FALCO_SOURCE = 'falco'

// staleAfterMs default for the Falco source — Falco heartbeat rule fires
// every ~60s; allow 5min before considering source stale.
const FALCO_STALE_AFTER_MS = 300_000

// Replay window over the alert's own `time` field (Falco-supplied).
const FALCO_REPLAY_WINDOW_MS = 5 * 60 * 1000

/**
 * Constant-time string compare. Returns true iff the two strings have
 * equal length AND equal bytes. Both must be present; absent token → false.
 */
function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export async function POST(req: NextRequest) {
  // 0. Body-size guard
  const sizeCheck = checkWebhookBodySize(req)
  if (!sizeCheck.ok) {
    if (sizeCheck.reason === 'too_large') {
      return NextResponse.json(
        { error: `Request body exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes` },
        { status: 413 }
      )
    }
    return NextResponse.json(
      { error: 'Content-Length header required' },
      { status: 411 }
    )
  }

  // 1. Read raw body + bearer token header
  const bodyText = await req.text()
  const token =
    req.headers.get('X-Orion-Falco-Token') ||
    req.headers.get('x-orion-falco-token')

  // 2. Verify bearer token (constant-time compare)
  if (!process.env.FALCO_WEBHOOK_SECRET) {
    const refuse = warnMissingWebhookSecret('falco', 'FALCO_WEBHOOK_SECRET')
    if (refuse) {
      return NextResponse.json(
        { error: 'Webhook secret not configured (server misconfigured)' },
        { status: 500 }
      )
    }
    if (!isLoopbackWebhookRequest(req)) {
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 403 })
    }
  } else {
    if (!constantTimeEqual(token, process.env.FALCO_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
  }

  // 3. Parse + validate Falco alert shape (need this before replay check —
  // the timestamp lives inside the body, not in a header).
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const validation = falcoAlertSchema.safeParse(parsed)
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid Falco alert shape', issues: validation.error.flatten() },
      { status: 400 }
    )
  }
  const alert = validation.data

  // 4. Replay window — verify alert.time is within 5 minutes of now.
  // Falcosidekick can't sign a separate timestamp header, but Falco's own
  // `time` field is included in the alert body and is what we'd verify
  // anyway. Missing/unparseable time → reject. Don't apply this check to
  // heartbeats — they're already idempotent.
  if (!isHeartbeat(alert)) {
    if (typeof alert.time !== 'string') {
      return NextResponse.json(
        { error: 'Falco alert missing required `time` field' },
        { status: 400 }
      )
    }
    const alertTime = Date.parse(alert.time)
    if (!Number.isFinite(alertTime)) {
      return NextResponse.json({ error: 'Falco alert has unparseable `time`' }, { status: 400 })
    }
    const skew = Math.abs(Date.now() - alertTime)
    if (skew > FALCO_REPLAY_WINDOW_MS) {
      return NextResponse.json(
        { error: 'Alert outside replay window (>5min skew)' },
        { status: 410 }
      )
    }
  }

  // 5. Pull environmentId from output_fields (injected by Falcosidekick CUSTOMFIELDS)
  const envIdRaw = alert.output_fields?.environmentId
  if (typeof envIdRaw !== 'string' || envIdRaw.length === 0) {
    return NextResponse.json(
      {
        error:
          'Falco alert missing environmentId in output_fields — Falcosidekick CUSTOMFIELDS not configured',
      },
      { status: 400 }
    )
  }
  const environmentId = envIdRaw

  // 6. Verify the environment exists (except for the literal "host" which
  // identifies the Orion host itself per the Phase 1 amendment in PR7).
  if (environmentId !== 'host') {
    const exists = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { id: true },
    })
    if (!exists) {
      return NextResponse.json(
        { error: `Unknown environmentId: ${environmentId}` },
        { status: 404 }
      )
    }
  }

  const now = new Date()
  const isHostScoped = environmentId === 'host'

  /**
   * Bump the appropriate source-health row.
   *
   * For envId="host" we must use the global SourceHealth table — the
   * EnvironmentSourceHealth.environmentId column is a FK to Environment
   * and "host" is not a real Environment row. For real env IDs we use
   * EnvironmentSourceHealth.
   */
  async function bumpSourceHealth() {
    if (isHostScoped) {
      await prisma.sourceHealth.upsert({
        where: { source: FALCO_SOURCE },
        update: { lastSeenAt: now },
        create: {
          source: FALCO_SOURCE,
          lastSeenAt: now,
          lastWatermark: null,
          staleAfterMs: FALCO_STALE_AFTER_MS,
        },
      })
    } else {
      await prisma.environmentSourceHealth.upsert({
        where: {
          environmentId_source: { environmentId, source: FALCO_SOURCE },
        },
        update: { lastSeenAt: now },
        create: {
          environmentId,
          source: FALCO_SOURCE,
          lastSeenAt: now,
          lastWatermark: null,
          staleAfterMs: FALCO_STALE_AFTER_MS,
        },
      })
    }
  }

  // 7. Heartbeat path — bump lastSeenAt only, no SecurityEvent
  if (isHeartbeat(alert)) {
    await bumpSourceHealth()
    return NextResponse.json({ received: true, kind: 'heartbeat', environmentId })
  }

  // 8. Real alert path — normalize and insert
  const normalized = normalizeFalcoAlert(alert, environmentId)
  const id = crypto.randomUUID()

  // Dedup check (24h window, matches host-agent pattern)
  const existing = await prisma.securityEvent.findFirst({
    where: {
      source: FALCO_SOURCE,
      dedupKey: normalized.dedupKey,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  })

  let inserted = false
  if (!existing) {
    await prisma.securityEvent.create({
      data: {
        id,
        environmentId: isHostScoped ? null : environmentId,
        type: normalized.type,
        source: normalized.source,
        severity: normalized.severity,
        title: normalized.title,
        description: normalized.description ?? null,
        rawEvent: normalized.rawEvent as any,
        dedupKey: normalized.dedupKey,
        firstSeen: normalized.timestamp ?? now,
        lastSeen: normalized.timestamp ?? now,
        createdAt: normalized.timestamp ?? now,
      },
    })
    inserted = true
  }

  // 9. Bump source-health (path varies for host vs managed env)
  await bumpSourceHealth()

  return NextResponse.json({
    received: true,
    kind: 'alert',
    environmentId,
    inserted,
    dedupKey: normalized.dedupKey,
  })
}
