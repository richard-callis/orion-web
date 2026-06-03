/**
 * Wazuh webhook endpoint.
 *
 * Receives alerts from Wazuh's webhook callback configuration.
 * Wazuh sends alert JSON via POST with X-Wazuh-Signature header.
 *
 * Auth: HMAC-SHA256 via X-Wazuh-Signature header. Secret stored in SecurityConfig.
 * Replay window: 5 minutes.
 * Idempotency: dedupKey from alert payload prevents duplicates within 60s.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizedEventSchema } from '@/lib/security/types'
import {
  verifyWebhookHmac,
  isWithinReplayWindow,
  wasAlreadyProcessed,
  isLoopbackWebhookRequest,
  warnMissingWebhookSecret,
  checkWebhookBodySize,
  WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/security/webhook-auth'
import { normalizeWazuhAlert, type WazuhAlert } from '@/lib/security/normalize/wazuh'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ── Request handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const envId = req.nextUrl.searchParams.get('env') || process.env.ENVIRONMENT_ID || ''

  // 0. Body-size guard (rejects oversize/unsized requests BEFORE HMAC work).
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

  // 1. Read raw body (for HMAC verification)
  const bodyText = await req.text()
  const signature = req.headers.get('X-Wazuh-Signature') || req.headers.get('x-wazuh-signature')
  const timestamp = req.headers.get('X-Timestamp') || req.headers.get('x-timestamp')

  // 2. Verify HMAC signature
  if (!process.env.WAZUH_WEBHOOK_SECRET) {
    // See crowdsec/route.ts for the rationale. Production refuses
    // unauthenticated traffic; dev accepts loopback only and never trusts
    // raw X-Forwarded-For.
    const refuse = warnMissingWebhookSecret('wazuh', 'WAZUH_WEBHOOK_SECRET')
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
    const secret = process.env.WAZUH_WEBHOOK_SECRET
    if (!verifyWebhookHmac(secret, bodyText, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // 3. Check replay window
  if (!isWithinReplayWindow(timestamp)) {
    return NextResponse.json({ error: 'Request expired (replay window exceeded)' }, { status: 410 })
  }

  // 4. Parse and validate
  let alert: WazuhAlert
  try {
    alert = JSON.parse(bodyText) as WazuhAlert
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!alert.alert) {
    return NextResponse.json({ error: 'Missing alert field in Wazuh payload' }, { status: 400 })
  }

  // 5. Normalize
  let event
  try {
    event = normalizeWazuhAlert(alert)
  } catch {
    return NextResponse.json({ error: 'Failed to parse event' }, { status: 400 })
  }

  // 6. Enrich with environment
  event.environmentId = envId || null

  // 7. Validate with Zod
  const parsed = normalizedEventSchema.parse(event)

  // 8. Idempotency check
  if (await wasAlreadyProcessed(parsed.dedupKey, 'wazuh')) {
    return NextResponse.json({ received: true, idempotent: true })
  }

  // 9. Insert into DB
  await prisma.securityEvent.create({
    data: {
      id: parsed.id,
      environmentId: parsed.environmentId,
      type: parsed.type,
      source: parsed.source,
      severity: parsed.severity,
      title: parsed.title,
      description: parsed.description ?? null,
      rawEvent: parsed.rawEvent as any,
      dedupKey: parsed.dedupKey,
      firstSeen: parsed.timestamp,
      lastSeen: parsed.timestamp,
      // createdAt intentionally omitted — let DB @default(now()) set ingestion time
      // so the correlator's window filter works correctly. firstSeen holds the forensic source timestamp.
    },
  })

  // 10. Update source health
  await prisma.sourceHealth.upsert({
    where: { source: 'wazuh' },
    update: { lastSeenAt: new Date() },
    create: {
      environmentId: envId || null,
      source: 'wazuh',
      lastSeenAt: new Date(),
      lastWatermark: parsed.timestamp,
      staleAfterMs: 5 * 60 * 1000, // 5 minutes
    },
  })

  return NextResponse.json({ received: true, id: parsed.id, idempotent: false })
}
