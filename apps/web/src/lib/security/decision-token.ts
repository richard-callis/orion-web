/**
 * Defense-in-depth signed decision tokens — action-service signer side.
 *
 * Gateway write tools (crowdsec_decision_create/delete, wazuh_active_response,
 * firewall_block) refuse to execute without a valid, fresh, target-bound
 * `__decision_token` minted here. The token binds the gateway call to a
 * specific ActionAudit row, action type, and target so it cannot be replayed
 * across tools, targets, or audit rows.
 *
 * Token format: <base64url(payload)>.<base64url(hmac)>
 *   payload = JSON.stringify({ auditId, actionType, target, exp })
 *   hmac    = HMAC-SHA256(payloadBytes, ACTION_SERVICE_TOKEN_SECRET)
 *
 * MIRROR OF apps/gateway/src/lib/decision-token.ts — the gateway only
 * verifies (never signs); this module only signs (never verifies).
 * Keep the format in sync if you change either side.
 */

import { createHmac } from 'crypto'

const TOKEN_TTL_MS = 5 * 60 * 1000 // 5 minutes — matches gateway replay window

function getSecret(): Buffer {
  const secret = process.env.ACTION_SERVICE_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'ACTION_SERVICE_TOKEN_SECRET is not set or too short (must be ≥32 chars). ' +
      'Generate with: openssl rand -hex 32'
    )
  }
  return Buffer.from(secret, 'utf8')
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Mint a decision token for a specific ActionAudit row + gateway call.
 * The token expires in 5 minutes and is bound to the actionType and target
 * so the gateway can reject replays across tools or targets.
 */
export function signDecisionToken(params: {
  auditId: string
  actionType: string
  target: string
}): string {
  const payload = JSON.stringify({
    auditId: params.auditId,
    actionType: params.actionType,
    target: params.target,
    exp: Date.now() + TOKEN_TTL_MS,
  })

  const payloadBuf = Buffer.from(payload, 'utf8')
  const mac = createHmac('sha256', getSecret()).update(payloadBuf).digest()

  return `${b64urlEncode(payloadBuf)}.${b64urlEncode(mac)}`
}
