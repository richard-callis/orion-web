import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'crypto'

// `webhook-auth.ts` imports `@/lib/db` for the idempotency-cache helper. The
// pure HMAC + replay-window helpers don't touch prisma, so stub the import so
// vitest can resolve the module without next.js path aliasing.
vi.mock('@/lib/db', () => ({ prisma: {} }))

import { verifyWebhookHmac, isWithinReplayWindow } from './webhook-auth'

const secret = 'super-secret-key'
const body = JSON.stringify({ event: 'login_failure', ip: '203.0.113.7' })

function sign(payload: string, key = secret): string {
  return `sha256=${createHmac('sha256', key).update(payload).digest('hex')}`
}

describe('verifyWebhookHmac (BLOCK-1 regression — timing-safe comparison)', () => {
  it('returns true for a valid signature', () => {
    expect(verifyWebhookHmac(secret, body, sign(body))).toBe(true)
  })

  it('returns false when signature header is missing', () => {
    expect(verifyWebhookHmac(secret, body, null)).toBe(false)
  })

  it('returns false on a forged signature of the correct length', () => {
    const valid = sign(body)
    // Flip the final hex char to keep length identical but value wrong.
    const tampered = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0')
    expect(verifyWebhookHmac(secret, body, tampered)).toBe(false)
  })

  it('returns false when signature uses the wrong secret', () => {
    expect(verifyWebhookHmac(secret, body, sign(body, 'wrong-secret'))).toBe(false)
  })

  it('returns false on a length mismatch without throwing (timingSafeEqual length leak guard)', () => {
    // Node.js crypto.timingSafeEqual throws on length mismatch; we must
    // length-check first and return false. This regression guards against
    // a future refactor that drops the length check.
    expect(() => verifyWebhookHmac(secret, body, 'sha256=tooshort')).not.toThrow()
    expect(verifyWebhookHmac(secret, body, 'sha256=tooshort')).toBe(false)
  })

  it('rejects a signature that differs only in case (HMAC hex is lowercase)', () => {
    const valid = sign(body)
    expect(verifyWebhookHmac(secret, body, valid.toUpperCase())).toBe(false)
  })
})

describe('isWithinReplayWindow', () => {
  it('returns true when there is no timestamp header', () => {
    expect(isWithinReplayWindow(null)).toBe(true)
  })

  it('returns true for a recent ISO timestamp', () => {
    const now = new Date().toISOString()
    expect(isWithinReplayWindow(now)).toBe(true)
  })

  it('returns false for an ISO timestamp outside the replay window', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 hour ago
    expect(isWithinReplayWindow(old)).toBe(false)
  })
})
