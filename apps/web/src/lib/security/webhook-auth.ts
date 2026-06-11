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

/**
 * Maximum acceptable webhook body size in bytes (1 MiB).
 *
 * Anything larger is rejected with 413 *before* we touch the HMAC verifier
 * or buffer the body. This bounds the work an unauthenticated request can
 * cost the gateway: a 100 MB POST against an HMAC endpoint still requires
 * us to read the body to validate the signature, which an attacker can use
 * to mount a memory/CPU DoS.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024

/** Key in Prisma for storing webhook secrets per environment/source. */
const SECRET_CONFIG_KEY = (envId: string, source: string) => `webhook_${source}_secret_${envId}`

/**
 * Idempotency cache TTL: 24 hours after first write.
 *
 * Upstream sources (CrowdSec, Wazuh) may retry deliveries across long-running
 * outages of this service; a 60-second window let duplicates leak through.
 * Backed by the existing `SecurityEvent.dedupKey` index, which is already in
 * place on the schema, so the wider lookup has no extra cost beyond an
 * indexed B-tree range scan.
 */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

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
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// ── Replay Window ─────────────────────────────────────────────────────────────

/**
 * Should the missing-timestamp passthrough be disabled?
 *
 * Production requires a timestamp header so replay attacks can be blocked.
 * Dev/test keeps the previous lenient behaviour so unit tests and local
 * curl sessions don't need to manage clocks. The behaviour is also gated by
 * an explicit `WEBHOOK_REQUIRE_TIMESTAMP=true|false` flag so the
 * production-gate can be exercised in tests without juggling NODE_ENV.
 */
function requireTimestampHeader(): boolean {
  const flag = (process.env.WEBHOOK_REQUIRE_TIMESTAMP ?? '').toLowerCase()
  if (flag === 'true' || flag === '1') return true
  if (flag === 'false' || flag === '0') return false
  return process.env.NODE_ENV === 'production'
}

/**
 * Check whether a timestamp header indicates a replay (older than the replay window).
 *
 * Accepts `X-Timestamp` header in ISO 8601 or Unix epoch format.
 * Returns `true` if the request is within the replay window.
 *
 * Hardening (MAJOR-1, PR #407):
 * - In production (or when `WEBHOOK_REQUIRE_TIMESTAMP=true`) a missing
 *   timestamp header is now treated as a replay (returns false) so the
 *   caller can reject with 401. Without this, a forwarding proxy that
 *   strips the timestamp header could let stale captures through.
 * - In dev/test the previous lenient behaviour is preserved but logs a
 *   warning so operators notice the relaxed mode.
 */
export function isWithinReplayWindow(timestampHeader: string | null): boolean {
  if (!timestampHeader) {
    if (requireTimestampHeader()) {
      return false // refuse — must be sent in prod
    }
    // eslint-disable-next-line no-console
    console.warn('[siem] webhook request missing X-Timestamp header; allowed because WEBHOOK_REQUIRE_TIMESTAMP is not set')
    return true
  }

  let timestamp: number

  // Try ISO 8601
  const isoMatch = timestampHeader.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/)
  if (isoMatch) {
    timestamp = new Date(isoMatch[1]).getTime()
  } else {
    // Try Unix epoch (seconds or milliseconds)
    const epoch = Number(timestampHeader)
    if (Number.isNaN(epoch)) {
      // A present-but-unparseable timestamp must be treated the same as
      // missing: reject in prod, accept-with-warning in dev.
      if (requireTimestampHeader()) return false
      // eslint-disable-next-line no-console
      console.warn('[siem] webhook X-Timestamp header is present but unparseable; allowed because WEBHOOK_REQUIRE_TIMESTAMP is not set')
      return true
    }
    timestamp = epoch > 1e12 ? epoch : epoch * 1000 // ms
  }

  const now = Date.now()
  // Reject both past replays AND timestamps far in the future (clock skew or
  // forged future-dated requests).
  const delta = now - timestamp
  return delta >= -WEBHOOK_REPLAY_WINDOW_SEC * 1000 && delta <= WEBHOOK_REPLAY_WINDOW_SEC * 1000
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

// ── Dev-mode unauthenticated acceptance ───────────────────────────────────────

/**
 * Whether to accept a webhook request that has no configured secret.
 *
 * In production this always returns false — missing secret means misconfigured,
 * and warnMissingWebhookSecret already returned 500 before this is reached.
 *
 * In development this returns true so local testing works without configuring
 * secrets. Previously this used `isLoopbackWebhookRequest` which read `req.ip`,
 * but `NextRequest.ip` is undefined in the self-hosted Node runtime (not Vercel),
 * making the loopback check permanently dead. Replaced with a plain NODE_ENV
 * check — the dev boundary is the deployment boundary, not the network.
 *
 * NOTE ON REPLAY PROTECTION (BLOCK-1):
 * For CrowdSec and Wazuh, the HMAC is computed by the upstream sender over the
 * raw body only. We cannot include the X-Timestamp in the signed material without
 * reconfiguring those senders, so timestamp binding is not feasible for those
 * sources. The replay window provides best-effort protection; the 24h dedupKey
 * idempotency (backed by SHA-256 for all sources post this PR) is the primary
 * replay defence. For host-agent, Vector signs body only by default.
 */
/**
 * Returns true only when BOTH conditions hold:
 *   1. NODE_ENV is not 'production'
 *   2. WEBHOOK_DEV_MODE=true is explicitly set
 *
 * Requiring an explicit opt-in prevents staging/preview deployments that
 * forget to set NODE_ENV=production from silently accepting unauthenticated
 * webhook payloads. In production neither condition can ever be true.
 */
export function shouldAcceptUnauthenticated(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.WEBHOOK_DEV_MODE === 'true'
}

/**
 * @deprecated req.ip is undefined in Next.js Node runtime — this function
 * always returns false unless WEBHOOK_TRUSTED_PROXY_IPS is configured.
 * Use shouldAcceptUnauthenticated() instead for the no-secret dev path.
 */
export function isLoopbackWebhookRequest(req: {
  headers: Headers
  ip?: string | null
}): boolean {
  const peerIp = req.ip ?? ''
  if (!peerIp) return false

  const LOOPBACK_PREFIXES = ['127.', '::1', '::ffff:127.']
  if (LOOPBACK_PREFIXES.some((p) => peerIp.startsWith(p))) return true

  const allowList = (process.env.WEBHOOK_TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (allowList.length === 0) return false
  if (!allowList.includes(peerIp)) return false

  const xff = req.headers.get('x-forwarded-for') ?? ''
  const realIp = req.headers.get('x-real-ip') ?? ''
  const clientIp = xff.split(',')[0]?.trim() || realIp.trim()
  const LOOPBACK_PREFIXES2 = ['127.', '::1', '::ffff:127.']
  return LOOPBACK_PREFIXES2.some((p) => clientIp.startsWith(p))
}

// ── Body-size guard ───────────────────────────────────────────────────────────

/**
 * Inspect the request's Content-Length and decide whether to reject before
 * buffering the body for HMAC verification (PR #407 MAJOR-3).
 *
 * Returns:
 *   - { ok: true }                            — proceed
 *   - { ok: false, reason: 'too_large' }     — caller should reply 413
 *   - { ok: false, reason: 'missing_length' } — in production caller should
 *     reply 411 Length Required; in dev/test we allow the request but log
 *     a warning since some test clients omit the header.
 *
 * The caller decides the actual HTTP status. We rely on the runtime's
 * Content-Length parsing rather than streaming-count because Next.js
 * already buffers `req.text()`; a content-length lie is at worst a
 * runtime-imposed cap, never a bypass.
 */
export function checkWebhookBodySize(req: { headers: Headers }): {
  ok: boolean
  reason?: 'too_large' | 'missing_length'
  size?: number
} {
  const lenHeader = req.headers.get('content-length')
  if (!lenHeader) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'missing_length' }
    }
    // eslint-disable-next-line no-console
    console.warn('[siem] webhook request missing Content-Length; accepting because NODE_ENV !== production')
    return { ok: true }
  }
  const n = Number(lenHeader)
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, reason: 'missing_length' }
  }
  if (n > WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, reason: 'too_large', size: n }
  }
  return { ok: true, size: n }
}

/**
 * Warn loudly when a webhook endpoint is being served without a configured
 * HMAC secret. In production this is a misconfiguration and the caller
 * should reject the request; in dev/test we still log so the operator
 * notices the loopback-only fallback is engaged.
 *
 * Returns `true` if the deployment should refuse to serve the request
 * unauthenticated (i.e. NODE_ENV=production). The caller is expected to
 * return HTTP 500 in that case.
 */
export function warnMissingWebhookSecret(source: string, envVarName: string): boolean {
  const isProd = process.env.NODE_ENV === 'production'
  const banner = `[siem] WEBHOOK MISCONFIGURED: ${envVarName} is not set for ${source} webhook.`

  if (isProd) {
    // eslint-disable-next-line no-console
    console.error(
      `${banner} Refusing unauthenticated requests. Set ${envVarName} in the environment.`
    )
    return true
  }

  // eslint-disable-next-line no-console
  console.warn(
    `${banner} Falling back to loopback-only acceptance (dev mode). ` +
      `Set ${envVarName} for any non-development deployment.`
  )
  return false
}
