/**
 * CrowdSec webhook endpoint.
 *
 * Receives alerts from CrowdSec's webhook notifier when security events
 * are detected (bans, blocks, etc.).
 *
 * Auth: HMAC-SHA256 via X-Signature header. Secret stored in SecurityConfig.
 * Replay window: 5 minutes.
 * Idempotency: dedupKey from event payload prevents duplicates within 60s.
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
} from '@/lib/security/webhook-auth'
import { normalizeCrowdSecAlert, type CrowdSecAlert } from '@/lib/security/normalize/crowdsec'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ── Request handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const envId = req.nextUrl.searchParams.get('env') || process.env.ENVIRONMENT_ID || ''

  // 1. Read raw body (for HMAC verification)
  const bodyText = await req.text()
  const signature = req.headers.get('X-Signature') || req.headers.get('x-crowdsec-signature')
  const timestamp = req.headers.get('X-Timestamp') || req.headers.get('x-timestamp')

  // 2. Verify HMAC signature
  if (!process.env.CROWDSEC_WEBHOOK_SECRET) {
    // No secret configured. Production must reject (misconfigured); dev
    // accepts only loopback requests verified via the direct TCP source
    // (or a WEBHOOK_TRUSTED_PROXY_IPS-allowlisted proxy hop). The previous
    // implementation trusted unvalidated X-Forwarded-For, which any HTTP
    // client could spoof. See `isLoopbackWebhookRequest` for the policy.
    const refuse = warnMissingWebhookSecret('crowdsec', 'CROWDSEC_WEBHOOK_SECRET')
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
    const secret = process.env.CROWDSEC_WEBHOOK_SECRET
    if (!verifyWebhookHmac(secret, bodyText, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // 3. Check replay window
  if (!isWithinReplayWindow(timestamp)) {
    return NextResponse.json({ error: 'Request expired (replay window exceeded)' }, { status: 410 })
  }

  // 4. Parse and validate
  let alert: CrowdSecAlert
  try {
    alert = JSON.parse(bodyText) as CrowdSecAlert
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // 5. Normalize
  let event
  try {
    event = normalizeCrowdSecAlert(alert)
  } catch {
    return NextResponse.json({ error: 'Failed to parse event' }, { status: 400 })
  }

  // 6. Enrich with environment
  event.environmentId = envId || null

  // 7. Validate with Zod
  const parsed = normalizedEventSchema.parse(event)

  // 8. Idempotency check
  if (await wasAlreadyProcessed(parsed.dedupKey, 'crowdsec')) {
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
      createdAt: parsed.timestamp,
    },
  })

  // 10. Update source health
  await prisma.sourceHealth.upsert({
    where: { source: 'crowdsec' },
    update: { lastSeenAt: new Date() },
    create: {
      source: 'crowdsec',
      environmentId: envId || null,
      lastSeenAt: new Date(),
      lastWatermark: parsed.timestamp,
      staleAfterMs: 5 * 60 * 1000, // 5 minutes
    },
  })

  return NextResponse.json({ received: true, id: parsed.id, idempotent: false })
}
