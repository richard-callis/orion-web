/**
 * Defense-in-depth signed decision tokens — gateway verifier side.
 *
 * Gateway write tools (crowdsec_decision_create/delete, wazuh_active_response,
 * firewall_block) refuse to execute without a valid, fresh, target-bound
 * `__decision_token` minted by the action-service. This ensures these
 * mutating tools cannot be invoked by an agent directly — they must be
 * routed through the action-service decision/audit layer.
 *
 * Token format: <base64url(payload)>.<base64url(hmac)>
 *   payload = JSON.stringify({ auditId, actionType, target, exp, params? })
 *   hmac    = HMAC-SHA256(payloadBytes, ACTION_SERVICE_TOKEN_SECRET)
 *
 * `params` (optional) binds additional tool arguments (e.g. scope, duration)
 * so they cannot be altered after signing. Tokens without `params` are still
 * accepted, but then the caller may only use each bound argument's default.
 *
 * MIRROR OF apps/web/src/lib/security/decision-token.ts — keep in sync.
 * The gateway only verifies (never signs), so signDecisionToken is omitted.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export interface DecisionTokenPayload {
  auditId: string
  actionType: string
  target: string
  /** Unix ms expiry timestamp. */
  exp: number
  /** Optional additional bound arguments. */
  params?: Record<string, string>
}

function getSecret(): Buffer {
  const secret = process.env.ACTION_SERVICE_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('ACTION_SERVICE_TOKEN_SECRET not configured')
  }
  return Buffer.from(secret, 'utf8')
}

function b64urlDecode(s: string): Buffer {
  // Pad back to multiple of 4 for base64 decoding.
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Verify a decision token. Throws on any failure (malformed, bad signature,
 * expired, mismatched actionType/target, or a bound param that doesn't match).
 * Returns the parsed payload on success.
 *
 * `expected.params` lists the tool arguments that must be bound: each entry
 * gives the value actually being used and the default that legacy tokens
 * (without `params`) are implicitly limited to.
 */
export function verifyDecisionToken(
  token: string,
  expected: {
    actionType: string
    target: string
    params?: Record<string, { value: string; default: string }>
  },
): DecisionTokenPayload {
  const secret = getSecret()

  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token: empty')
  }
  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new Error('token: malformed (expected <payload>.<hmac>)')
  }
  const [payloadB64, macB64] = parts

  const payloadBytes = b64urlDecode(payloadB64)
  const macBytes = b64urlDecode(macB64)

  // Recompute HMAC and compare in constant time.
  const expectedMac = createHmac('sha256', secret).update(payloadBytes).digest()
  if (macBytes.length !== expectedMac.length || !timingSafeEqual(macBytes, expectedMac)) {
    throw new Error('token: bad signature')
  }

  let payload: DecisionTokenPayload
  try {
    payload = JSON.parse(payloadBytes.toString('utf8')) as DecisionTokenPayload
  } catch {
    throw new Error('token: payload not valid JSON')
  }

  if (
    typeof payload.auditId !== 'string' ||
    typeof payload.actionType !== 'string' ||
    typeof payload.target !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('token: payload missing required fields')
  }
  if (payload.params !== undefined && (typeof payload.params !== 'object' || payload.params === null)) {
    throw new Error('token: params must be an object')
  }

  if (!(payload.exp > Date.now())) {
    throw new Error('token: expired')
  }

  if (payload.actionType !== expected.actionType) {
    throw new Error('token: actionType mismatch')
  }

  if (payload.target !== expected.target) {
    throw new Error('token: target mismatch')
  }

  for (const [key, { value, default: dflt }] of Object.entries(expected.params ?? {})) {
    const bound = payload.params?.[key]
    const allowed = bound === undefined ? dflt : String(bound)
    if (value !== allowed) {
      throw new Error(`token: ${key} mismatch`)
    }
  }

  return payload
}

// ── Replay protection ────────────────────────────────────────────────────────
//
// A token is valid until `exp` (5 min). Without tracking, the same token could
// be replayed any number of times inside that window. Each (actionType, auditId)
// pair may be consumed once; entries are dropped after they expire, and the map
// is bounded so it cannot grow without limit.

const MAX_USED_ENTRIES = 10_000
const usedTokens = new Map<string, number>() // key → exp

function pruneUsed(now: number): void {
  for (const [k, exp] of usedTokens) {
    if (exp <= now) usedTokens.delete(k)
  }
  // Still over the cap: drop the oldest insertions (Map preserves insertion order).
  while (usedTokens.size > MAX_USED_ENTRIES) {
    const oldest = usedTokens.keys().next().value
    if (oldest === undefined) break
    usedTokens.delete(oldest)
  }
}

/** Mark a verified token as used. Throws if it was already consumed. */
export function consumeDecisionToken(payload: DecisionTokenPayload): void {
  const now = Date.now()
  pruneUsed(now)
  const key = `${payload.actionType}:${payload.auditId}`
  if (usedTokens.has(key)) {
    throw new Error('token: already used')
  }
  usedTokens.set(key, payload.exp)
}

/** Test helper — clears the replay cache. */
export function __resetDecisionTokenReplayCache(): void {
  usedTokens.clear()
}
