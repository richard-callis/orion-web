/**
 * Defense-in-depth signed decision tokens.
 *
 * The action-service signs a short-lived HMAC-SHA256 token that the gateway
 * verifies before executing a security write tool. This ensures gateway write
 * tools (crowdsec_decision_create/delete, wazuh_active_response, firewall_block)
 * cannot be invoked directly by an agent — they must be routed through the
 * action-service decision/audit layer.
 *
 * Token format: <base64url(payload)>.<base64url(hmac)>
 *   payload = JSON.stringify({ auditId, actionType, target, exp })
 *   hmac    = HMAC-SHA256(payloadBytes, ACTION_SERVICE_TOKEN_SECRET)
 *
 * Verification is timing-safe and binds the token to its actionType + target
 * to prevent cross-tool / cross-target replay.
 *
 * MIRROR: apps/gateway/src/lib/decision-token.ts (verifier side). Keep in sync.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export interface DecisionTokenPayload {
  auditId: string
  actionType: string
  target: string
  /** Unix ms expiry timestamp. */
  exp: number
}

const DEFAULT_TTL_MS = 60_000

function getSecret(): Buffer {
  const secret = process.env.ACTION_SERVICE_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('ACTION_SERVICE_TOKEN_SECRET not configured')
  }
  return Buffer.from(secret, 'utf8')
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Buffer {
  // Pad back to multiple of 4 for base64 decoding.
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Sign a decision token. Throws if `ACTION_SERVICE_TOKEN_SECRET` is unset or
 * shorter than 32 chars.
 */
export function signDecisionToken(
  payload: Omit<DecisionTokenPayload, 'exp'>,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const secret = getSecret()
  const full: DecisionTokenPayload = {
    auditId: payload.auditId,
    actionType: payload.actionType,
    target: payload.target,
    exp: Date.now() + ttlMs,
  }
  const payloadBytes = Buffer.from(JSON.stringify(full), 'utf8')
  const mac = createHmac('sha256', secret).update(payloadBytes).digest()
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(mac)}`
}

/**
 * Verify a decision token. Throws on any failure (malformed, bad signature,
 * expired, or mismatched actionType/target). Returns the parsed payload on
 * success.
 */
export function verifyDecisionToken(
  token: string,
  expected: { actionType: string; target: string },
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

  if (!(payload.exp > Date.now())) {
    throw new Error('token: expired')
  }

  if (payload.actionType !== expected.actionType) {
    throw new Error('token: actionType mismatch')
  }

  if (payload.target !== expected.target) {
    throw new Error('token: target mismatch')
  }

  return payload
}
