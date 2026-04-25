/**
 * SSO Header HMAC Protection — SOC2 [M-002]
 *
 * Authenticates SSO proxy headers with HMAC-SHA256 signatures.
 * Prevents header forgery when the reverse proxy is compromised or
 * when a malicious client injects headers directly.
 *
 * Flow:
 * 1. Proxy signs headers with HMAC:
 *    signature = HMAC-SHA256(SECRET, username + ":" + timestamp)
 *    Headers include:
 *      x-authentik-username: <username>
 *      x-authentik-timestamp: <epoch_ms>
 *      x-authentik-signature: <hex hmac>
 *
 * 2. ORION verifies:
 *    - Reconstructs the signature from the same secret and inputs
 *    - Checks timestamp within ±5 minute window (clock skew)
 *    - Rejects if signature doesn't match
 *
 * Configuration:
 *   ORION_SSO_HMAC_SECRET — shared secret between proxy and ORION
 *   ORION_SSO_HMAC_ENABLED — set to "true" to require HMAC verification
 *
 * If ORION_SSO_HMAC_SECRET is not set, HMAC verification is disabled
 * but the existing header-based auth still works (backward compatible).
 */

import crypto from 'crypto'

const HMAC_SECRET_ENV = 'ORION_SSO_HMAC_SECRET'
const HMAC_ENABLED_ENV = 'ORION_SSO_HMAC_ENABLED'
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Check if SSO HMAC verification is enabled.
 */
export function isSsoHmacEnabled(): boolean {
  return process.env[HMAC_ENABLED_ENV] === 'true' || process.env[HMAC_ENABLED_ENV] === '1'
}

/**
 * Get the HMAC secret, or null if not configured.
 */
export function getSsoHmacSecret(): string | null {
  return process.env[HMAC_SECRET_ENV] ?? null
}

/**
 * Generate an HMAC-SHA256 signature for SSO proxy headers.
 * Called by the reverse proxy to sign incoming requests.
 */
export function signSsoHeader(username: string, timestamp: number, secret: string): string {
  const payload = `${username}:${timestamp}`
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Verify an HMAC signature from an SSO proxy request.
 * Returns true if valid, false otherwise.
 */
export function verifySsoHmac(
  username: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  if (!isSsoHmacEnabled()) return true // backward compatible

  const secret = getSsoHmacSecret()
  if (!secret) return false // enabled but no secret = reject

  if (!timestamp || !signature) return false

  // Check timestamp freshness
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts)) return false
  const now = Date.now()
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_MS) {
    return false // timestamp too old or in the future
  }

  // Verify signature
  const expected = signSsoHeader(username, ts, secret)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  } catch {
    return false
  }
}
