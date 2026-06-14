/**
 * Host-agent ingest webhook endpoint.
 *
 * Receives security telemetry batches from the Vector shipper running on
 * the Orion management host. Vector ships journald, Docker socket events,
 * Vault audit logs, and edge container logs (Traefik/Authentik) as JSON
 * batches.
 *
 * Auth: HMAC-SHA256 via X-Signature header, matching the existing
 * webhook-auth pattern. Secret read from process.env.HOST_AGENT_WEBHOOK_SECRET
 * with loopback fallback for dev — consistent with crowdsec/wazuh routes.
 *
 * Batch format:
 *   { batch_id, hostname, events: [{ category, subtype, severity, timestamp, source_file, raw }] }
 *
 * Divergence: existing webhooks (crowdsec, wazuh) accept singleton events
 * because that's how those upstreams push. Host-agent is log shipping —
 * Vector batches natively, and forcing one request per event would burn
 * CPU and add latency on the host.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  verifyWebhookHmac,
  isWithinReplayWindow,
  wasAlreadyProcessed,
  shouldAcceptUnauthenticated,
  warnMissingWebhookSecret,
  checkWebhookBodySize,
  WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/security/webhook-auth'
import { hostAgentBatchSchema } from '@/lib/security/types'
import { normalizeHostAgentEvent, type HostAgentEvent } from '@/lib/security/normalize/host-agent'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ── Request handler ──────────────────────────────────────────────────────────

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

  // 1. Read body and parse outer envelope
  //
  // Vector's raw_message codec strips event fields before HTTP sink header
  // templates are evaluated, so {{ x_signature }} was sent literally instead
  // of interpolated. Signature is now embedded in the body as:
  //   { "sig": "sha256=<hex>", "payload": "<json-string>" }
  // HMAC is verified over `payload` (the exact string Vector signed) before
  // parsing the inner batch — no re-serialisation, no ordering ambiguity.
  const bodyText = await req.text()
  const timestamp = req.headers.get('X-Timestamp') || req.headers.get('x-timestamp')

  let outerEnvelope: { sig?: string; payload?: string } = {}
  try {
    outerEnvelope = JSON.parse(bodyText)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { sig: signature, payload: payloadStr } = outerEnvelope

  // 2. Verify HMAC over the raw payload string
  if (!process.env.HOST_AGENT_WEBHOOK_SECRET) {
    const refuse = warnMissingWebhookSecret('host_agent', 'HOST_AGENT_WEBHOOK_SECRET')
    if (refuse) {
      return NextResponse.json(
        { error: 'Webhook secret not configured (server misconfigured)' },
        { status: 500 }
      )
    }
    if (!shouldAcceptUnauthenticated()) {
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 403 })
    }
  } else {
    const secret = process.env.HOST_AGENT_WEBHOOK_SECRET
    if (!payloadStr || !verifyWebhookHmac(secret, payloadStr, signature ?? null)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // 3. Check replay window
  if (!isWithinReplayWindow(timestamp)) {
    return NextResponse.json({ error: 'Request expired (replay window exceeded)' }, { status: 410 })
  }

  // 4. Parse inner payload and validate batch
  let batch: unknown
  try {
    batch = JSON.parse(payloadStr ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid payload JSON' }, { status: 400 })
  }

  let validatedBatch
  try {
    validatedBatch = hostAgentBatchSchema.parse(batch)
  } catch {
    return NextResponse.json(
      { error: 'Invalid batch format — expected { batch_id, hostname, events: [...] }' },
      { status: 400 }
    )
  }

  const { batch_id, hostname, events } = validatedBatch

  if (events.length === 0) {
    return NextResponse.json({
      received: true,
      batch_id,
      eventsProcessed: 0,
      eventsRejected: 0,
    })
  }

  // 5. Normalize each event once; separate into insert candidates vs rejected.
  //    Use in-batch dedup to avoid re-inserting the same event twice in a batch.
  const now = new Date()
  const seenDedupKeys = new Set<string>()
  const insertCandidates: Array<{
    id: string
    type: string
    source: string
    severity: number
    title: string
    description: string | null
    rawEvent: Record<string, unknown>
    dedupKey: string
    firstSeen: Date
    lastSeen: Date
    createdAt: Date
  }> = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const normalized = normalizeHostAgentEvent(
      { ...event, timestamp: event.timestamp, hostname } as HostAgentEvent,
      hostname
    )

    // In-batch dedup
    if (seenDedupKeys.has(normalized.dedupKey)) continue
    seenDedupKeys.add(normalized.dedupKey)

    normalized.id = crypto.randomUUID()

    const ts = normalized.timestamp ?? new Date()
    insertCandidates.push({
      id: normalized.id,
      type: normalized.type,
      source: normalized.source,
      severity: normalized.severity,
      title: normalized.title,
      description: normalized.description ?? null,
      rawEvent: normalized.rawEvent as any,
      dedupKey: normalized.dedupKey,
      firstSeen: ts,
      lastSeen: ts,
      createdAt: ts,
    })
  }

  // 6. Dedup against already-processed events (DB lookups in a loop — acceptable
  //    because host-agent batches are small, typically <50 events).
  const dedupChecks = await prisma.securityEvent.findMany({
    where: {
      source: 'host_agent',
      dedupKey: { in: insertCandidates.map((c) => c.dedupKey) },
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // last 24h
      },
    },
    select: { dedupKey: true },
  })
  const existingKeys = new Set(dedupChecks.map((e) => e.dedupKey))

  const toInsert = insertCandidates.filter((c) => !existingKeys.has(c.dedupKey))

  // 7. Batch insert SecurityEvents
  if (toInsert.length > 0) {
    await prisma.securityEvent.createMany({
      data: toInsert.map((c) => ({
        id: c.id,
        environmentId: null,
        type: c.type,
        source: c.source,
        severity: c.severity,
        title: c.title,
        description: c.description,
        rawEvent: c.rawEvent as any,
        dedupKey: c.dedupKey,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        // createdAt intentionally omitted — DB @default(now()) sets ingestion time.
      })),
    })
  }

  // 8. Update source health for host_agent
  await prisma.sourceHealth.upsert({
    where: { source: 'host_agent' },
    update: { lastSeenAt: now },
    create: {
      source: 'host_agent',
      lastSeenAt: now,
      lastWatermark: null,
      staleAfterMs: 120 * 1000, // 2 minutes
    },
  })

  return NextResponse.json({
    received: true,
    batch_id,
    eventsProcessed: insertCandidates.length,
    eventsInserted: toInsert.length,
    eventsRejected: insertCandidates.length - toInsert.length,
  })
}
