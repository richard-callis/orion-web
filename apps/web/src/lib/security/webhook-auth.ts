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

// ── Client-IP / Loopback Trust ────────────────────────────────────────────────

/**
 * Loopback IPv4/IPv6 prefixes. An address that starts with one of these is
 * considered "from this host" and is the only case the webhook fallback
 * (used when a webhook secret is not configured) should treat as trusted.
 */
const LOOPBACK_PREFIXES = ['127.', '::1', '::ffff:127.']

function isLoopbackIp(ip: string): boolean {
  if (!ip) return false
  const trimmed = ip.trim()
  if (!trimmed) return false
  return LOOPBACK_PREFIXES.some((p) => trimmed.startsWith(p))
}

/**
 * Determine whether the request originates from loopback for the secret-less
 * dev-mode fallback.
 *
 * Hardening (MAJOR-1 follow-up):
 * - The previous implementation read `X-Forwarded-For` / `X-Real-IP` directly,
 *   which any HTTP client can spoof. With `CROWDSEC_WEBHOOK_SECRET` (or the
 *   Wazuh equivalent) unset, spoofing `X-Forwarded-For: 127.0.0.1` was enough
 *   to inject events.
 * - We now prefer the direct TCP source (`req.ip`, populated by the runtime
 *   from the connection). `X-Forwarded-For` is ONLY consulted when the
 *   direct peer IP is itself an allow-listed reverse proxy
 *   (`WEBHOOK_TRUSTED_PROXY_IPS`, comma-separated). When the peer IP is
 *   missing AND no proxy allow-list is configured, we fall back to refusing
 *   trust — the request must use the signed path.
 *
 * Returns `true` only when we are confident the request is from loopback.
 */
export function isLoopbackWebhookRequest(req: {
  headers: Headers
  ip?: string | null
}): boolean {
  const peerIp = req.ip ?? ''
  if (isLoopbackIp(peerIp)) return true

  const allowList = (process.env.WEBHOOK_TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (allowList.length === 0) {
    // No proxy allow-list configured. Do not trust XFF — it is spoofable.
    return false
  }

  const peerTrusted = peerIp && allowList.includes(peerIp)
  if (!peerTrusted) return false

  // Peer is a known reverse proxy; X-Forwarded-For (left-most entry) is
  // believable. X-Real-IP is single-valued and easier to forge upstream, but
  // we accept it when the peer is also trusted.
  const xff = req.headers.get('x-forwarded-for') ?? ''
  const realIp = req.headers.get('x-real-ip') ?? ''
  const clientIp = xff.split(',')[0]?.trim() || realIp.trim()
  return isLoopbackIp(clientIp)
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
