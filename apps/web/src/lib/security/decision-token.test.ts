/**
 * Unit tests for signDecisionToken / verifyDecisionToken.
 *
 * These cover the defense-in-depth gate that prevents direct agent calls to
 * gateway write tools (crowdsec_decision_create/delete, wazuh_active_response,
 * firewall_block). The gateway-side verifier mirrors this implementation;
 * both are validated independently.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signDecisionToken, verifyDecisionToken } from './decision-token'

const SECRET = 'test-secret-must-be-at-least-32-chars-long!!'

describe('decision-token', () => {
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

  it('round-trips: sign → verify succeeds and returns the payload', () => {
    const token = signDecisionToken({
      auditId: 'audit-123',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    const payload = verifyDecisionToken(token, {
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    expect(payload.auditId).toBe('audit-123')
    expect(payload.actionType).toBe('crowdsec_decision_create')
    expect(payload.target).toBe('1.2.3.4')
    expect(payload.exp).toBeGreaterThan(Date.now())
  })

  it('rejects mismatched actionType', () => {
    const token = signDecisionToken({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    expect(() =>
      verifyDecisionToken(token, { actionType: 'firewall_block', target: '1.2.3.4' }),
    ).toThrow(/actionType mismatch/)
  })

  it('rejects mismatched target', () => {
    const token = signDecisionToken({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    expect(() =>
      verifyDecisionToken(token, { actionType: 'crowdsec_decision_create', target: '5.6.7.8' }),
    ).toThrow(/target mismatch/)
  })

  it('rejects an expired token', () => {
    // ttlMs = -1 → exp set in the past
    const token = signDecisionToken(
      { auditId: 'a', actionType: 'firewall_block', target: '10.0.0.0/24' },
      -1,
    )

    expect(() =>
      verifyDecisionToken(token, { actionType: 'firewall_block', target: '10.0.0.0/24' }),
    ).toThrow(/expired/)
  })

  it('rejects a tampered payload', () => {
    const token = signDecisionToken({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    const [, mac] = token.split('.')
    // Replace the payload with a forged one (still base64url) but keep the
    // original MAC — the recomputed HMAC will not match.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        auditId: 'a',
        actionType: 'crowdsec_decision_create',
        target: '5.6.7.8',
        exp: Date.now() + 60_000,
      }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(() =>
      verifyDecisionToken(`${forgedPayload}.${mac}`, {
        actionType: 'crowdsec_decision_create',
        target: '5.6.7.8',
      }),
    ).toThrow(/bad signature/)
  })

  it('rejects a tampered HMAC', () => {
    const token = signDecisionToken({
      auditId: 'a',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
    })

    const [payload] = token.split('.')
    // Flip the MAC by replacing it with a different valid-length base64url string.
    const fakeMac = Buffer.alloc(32, 0x42)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(() =>
      verifyDecisionToken(`${payload}.${fakeMac}`, {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/bad signature/)
  })

  it('rejects a malformed token (no dot)', () => {
    expect(() =>
      verifyDecisionToken('not-a-token', {
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/malformed/)
  })

  it('throws if ACTION_SERVICE_TOKEN_SECRET is unset (sign)', () => {
    delete process.env.ACTION_SERVICE_TOKEN_SECRET
    expect(() =>
      signDecisionToken({
        auditId: 'a',
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/ACTION_SERVICE_TOKEN_SECRET not configured/)
  })

  it('throws if ACTION_SERVICE_TOKEN_SECRET is unset (verify)', () => {
    const token = signDecisionToken({
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
      signDecisionToken({
        auditId: 'a',
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
      }),
    ).toThrow(/ACTION_SERVICE_TOKEN_SECRET not configured/)
  })
})
