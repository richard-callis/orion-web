/**
 * Unit tests for the gateway-side decision token verifier.
 *
 * The gateway never signs (action-service is the sole signer); to validate
 * verification end-to-end we re-implement the signer inline here. The signer
 * code is intentionally a duplicate (not imported from the web app) — the
 * gateway must not take a dependency on apps/web.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { verifyDecisionToken } from './decision-token'

const SECRET = 'test-secret-must-be-at-least-32-chars-long!!'

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Local mirror of the web-side signer — sufficient for verifier round-trip. */
function signLocal(
  payload: { auditId: string; actionType: string; target: string },
  ttlMs = 60_000,
): string {
  const full = { ...payload, exp: Date.now() + ttlMs }
  const payloadBytes = Buffer.from(JSON.stringify(full), 'utf8')
  const mac = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(payloadBytes).digest()
  return `${b64url(payloadBytes)}.${b64url(mac)}`
}

describe('decision-token verifier (gateway)', () => {
  const originalSecret = process.env.ACTION_SERVICE_TOKEN_SECRET

  beforeEach(() => {
    process.env.ACTION_SERVICE_TOKEN_SECRET = SECRET
  })

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ACTION_SERVICE_TOKEN_SECRET
    } else {
      process.env.ACTION_SERVICE_TOKEN_SECRET = originalSecret
    }
  })

  it('round-trips: sign → verify succeeds', () => {
    const token = signLocal({
      auditId: 'audit-1',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    const payload = verifyDecisionToken(token, {
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    expect(payload.auditId).toBe('audit-1')
  })

  it('rejects mismatched actionType', () => {
    const token = signLocal({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    expect(() =>
      verifyDecisionToken(token, { actionType: 'firewall_block', target: '1.2.3.4' }),
    ).toThrow(/actionType mismatch/)
  })

  it('rejects mismatched target', () => {
    const token = signLocal({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    expect(() =>
      verifyDecisionToken(token, { actionType: 'crowdsec_decision_create', target: '5.6.7.8' }),
    ).toThrow(/target mismatch/)
  })

  it('rejects expired tokens', () => {
    const token = signLocal(
      { auditId: 'a', actionType: 'firewall_block', target: '10.0.0.0/24' },
      -1,
    )
    expect(() =>
      verifyDecisionToken(token, { actionType: 'firewall_block', target: '10.0.0.0/24' }),
    ).toThrow(/expired/)
  })

  it('rejects tampered payload', () => {
    const token = signLocal({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    const [, mac] = token.split('.')
    const forgedPayload = b64url(
      Buffer.from(
        JSON.stringify({
          auditId: 'a',
          actionType: 'crowdsec_decision_create',
          target: '5.6.7.8',
          exp: Date.now() + 60_000,
        }),
        'utf8',
      ),
    )
    expect(() =>
      verifyDecisionToken(`${forgedPayload}.${mac}`, {
        actionType: 'crowdsec_decision_create',
        target: '5.6.7.8',
      }),
    ).toThrow(/bad signature/)
  })

  it('rejects tampered HMAC', () => {
    const token = signLocal({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    const [payload] = token.split('.')
    const fakeMac = b64url(Buffer.alloc(32, 0x42))
    expect(() =>
      verifyDecisionToken(`${payload}.${fakeMac}`, {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/bad signature/)
  })

  it('rejects malformed tokens', () => {
    expect(() =>
      verifyDecisionToken('no-dot-here', {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/malformed/)
  })

  it('throws if ACTION_SERVICE_TOKEN_SECRET is unset', () => {
    const token = signLocal({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })
    delete process.env.ACTION_SERVICE_TOKEN_SECRET
    expect(() =>
      verifyDecisionToken(token, {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/ACTION_SERVICE_TOKEN_SECRET not configured/)
  })

  it('throws if secret is shorter than 32 chars', () => {
    process.env.ACTION_SERVICE_TOKEN_SECRET = 'short'
    expect(() =>
      verifyDecisionToken('a.b', {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/ACTION_SERVICE_TOKEN_SECRET not configured/)
  })
})
