/**
 * Falco ingest webhook endpoint (Phase 2).
 *
 * Receives security alerts from Falcosidekick (deployed alongside each
 * managed environment AND on the Orion host per the Phase 2 plan).
 *
 * Auth: HMAC-SHA256 via X-Orion-Falco-Signature header — same pattern as
 * the host-agent webhook (X-Signature) and CrowdSec/Wazuh. Secret read from
 * process.env.FALCO_WEBHOOK_SECRET, loopback fallback for dev.
 *
 * Environment scoping: every alert MUST carry an environmentId injected by
 * Falcosidekick's CUSTOMFIELDS at deploy time. Per-environment routing of
 * alerts goes through the SAME endpoint — the environmentId determines
 * which EnvironmentSourceHealth row gets bumped and which environment the
 * SecurityEvent belongs to.
 *
 * Heartbeat handling: Falco's "Heartbeat" rule is a liveness ping. We bump
 * EnvironmentSourceHealth.lastSeenAt and do NOT insert a SecurityEvent.
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
  verifyWebhookHmac,
  isWithinReplayWindow,
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

  // 1. Read raw body for HMAC verification
  const bodyText = await req.text()
  const signature =
    req.headers.get('X-Orion-Falco-Signature') ||
    req.headers.get('x-orion-falco-signature') ||
    req.headers.get('X-Signature')
  const timestamp = req.headers.get('X-Timestamp') || req.headers.get('x-timestamp')

  // 2. Verify HMAC
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
    const secret = process.env.FALCO_WEBHOOK_SECRET
    if (!verifyWebhookHmac(secret, bodyText, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // 3. Replay window
  if (!isWithinReplayWindow(timestamp)) {
    return NextResponse.json(
      { error: 'Request expired (replay window exceeded)' },
      { status: 410 }
    )
  }

  // 4. Parse + validate Falco alert shape
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

  // 7. Heartbeat path — bump lastSeenAt only, no SecurityEvent
  if (isHeartbeat(alert)) {
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
        environmentId: environmentId === 'host' ? null : environmentId,
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

  // 9. Bump EnvironmentSourceHealth — both heartbeat and real alerts count
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

  return NextResponse.json({
    received: true,
    kind: 'alert',
    environmentId,
    inserted,
    dedupKey: normalized.dedupKey,
  })
}
