/**
 * Webhook authentication helper — HMAC verification, replay window, idempotency.
 *
 * Used by all security webhook endpoints to verify incoming events.
 */

import { prisma } from '@/lib/db'
import { createHmac, timingSafeEqual } from 'crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum replay window in seconds (5 minutes). */
export const WEBHOOK_REPLAY_WINDOW_SEC = 5 * 60

/** Key in Prisma for storing webhook secrets per environment/source. */
const SECRET_CONFIG_KEY = (envId: string, source: string) => `webhook_${source}_secret_${envId}`

/** Idempotency cache TTL: 60 seconds after first write. */
const IDEMPOTENCY_WINDOW_MS = 60_000

/** Key used to detect if an idempotent event was already processed. */
type IdempotencyKey = { dedupKey: string; source: string }

// ── HMAC Verification ─────────────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature of a webhook request.
 *
 * Computes HMAC-SHA256(secret, rawBody) and compares with the X-Signature header.
 * Signature format: `sha256=<hex>`. Returns false on any mismatch (length, value,
 * or missing header).
 */
export function verifyWebhookHmac(
  secret: string,
  rawBody: string,
  signature: string | null
): boolean {
  if (!signature) return false

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

  // Timing-safe comparison: any mismatch in length (or value) returns false in
  // constant time so we don't leak signature characters via response timing.
  return constantTimeCompare(signature, expected)
}

/**
 * Constant-time string comparison backed by Node.js `crypto.timingSafeEqual`.
 *
 * Notes:
 * - We require both buffers to be the same length BEFORE calling
 *   `timingSafeEqual` because Node.js will throw on length mismatch (which
 *   itself would be a timing side-channel via exception cost). We return
 *   `false` immediately when lengths differ.
 * - Inputs are encoded as UTF-8 bytes via `Buffer.from`. For our HMAC use
 *   case both strings are ASCII hex with a fixed `sha256=` prefix, so the
 *   byte length equals the string length.
 * - The previous implementation attempted `crypto.subtle.timingSafeEqual`
 *   which does not exist on the Web Crypto API; the cast always evaluated
 *   to undefined and the fallback was plain `===`, which is bypassable
 *   via a timing oracle. Fixed by routing through Node's `timingSafeEqual`.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// ── Replay Window ─────────────────────────────────────────────────────────────

/**
 * Check whether a timestamp header indicates a replay (older than the replay window).
 *
 * Accepts `X-Timestamp` header in ISO 8601 or Unix epoch format.
 * Returns `true` if the request is within the replay window.
 */
export function isWithinReplayWindow(timestampHeader: string | null): boolean {
  if (!timestampHeader) return true // no timestamp = allow (some sources don't send one)

  let timestamp: number

  // Try ISO 8601
  const isoMatch = timestampHeader.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/)
  if (isoMatch) {
    timestamp = new Date(isoMatch[1]).getTime()
  } else {
    // Try Unix epoch (seconds or milliseconds)
    const epoch = Number(timestampHeader)
    if (Number.isNaN(epoch)) return true
    timestamp = epoch > 1e12 ? epoch : epoch * 1000 // ms
  }

  const now = Date.now()
  return now - timestamp <= WEBHOOK_REPLAY_WINDOW_SEC * 1000
}

// ── Idempotency (dedupKey) ────────────────────────────────────────────────────

/**
 * Check whether an event with this dedupKey has already been processed recently.
 *
 * Uses the SecurityEvent table's dedupKey as the idempotency store.
 * Returns true if the event was ALREADY seen within the idempotency window.
 */
export async function wasAlreadyProcessed(
  dedupKey: string,
  source: string
): Promise<boolean> {
  const count = await prisma.securityEvent.count({
    where: {
      dedupKey,
      source,
      createdAt: {
        gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS),
      },
    },
  })
  return count > 0
}

// ── Secret Lookup ─────────────────────────────────────────────────────────────

/**
 * Retrieve the HMAC secret for a source from SecurityConfig.
 */
export async function getWebhookSecret(
  envId: string | null,
  source: string
): Promise<string | null> {
  if (!envId) return null

  const config = await prisma.securityConfig.findUnique({
    where: {
      environmentId_key: {
        environmentId: envId,
        key: SECRET_CONFIG_KEY(envId, source),
      },
    },
  })

  return config?.value ?? null
}
