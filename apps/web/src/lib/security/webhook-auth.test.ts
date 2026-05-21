import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'

// `webhook-auth.ts` imports `@/lib/db` for the idempotency-cache helper. The
// pure HMAC + replay-window helpers don't touch prisma, so stub the import so
// vitest can resolve the module without next.js path aliasing.
vi.mock('@/lib/db', () => ({ prisma: {} }))

import {
  verifyWebhookHmac,
  isWithinReplayWindow,
  isLoopbackWebhookRequest,
  warnMissingWebhookSecret,
} from './webhook-auth'

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

// Small helper so tests can build a request shape the same way the route does.
function makeReq(opts: { ip?: string | null; xff?: string; xRealIp?: string }) {
  const headers = new Headers()
  if (opts.xff !== undefined) headers.set('x-forwarded-for', opts.xff)
  if (opts.xRealIp !== undefined) headers.set('x-real-ip', opts.xRealIp)
  return { ip: opts.ip ?? null, headers }
}

describe('isLoopbackWebhookRequest (MAJOR-1 — X-Forwarded-For hardening)', () => {
  const originalEnv = process.env.WEBHOOK_TRUSTED_PROXY_IPS
  beforeEach(() => {
    delete process.env.WEBHOOK_TRUSTED_PROXY_IPS
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WEBHOOK_TRUSTED_PROXY_IPS
    else process.env.WEBHOOK_TRUSTED_PROXY_IPS = originalEnv
  })

  it('trusts a direct loopback peer (req.ip = 127.0.0.1)', () => {
    expect(isLoopbackWebhookRequest(makeReq({ ip: '127.0.0.1' }))).toBe(true)
  })

  it('trusts an IPv6 loopback peer (::1)', () => {
    expect(isLoopbackWebhookRequest(makeReq({ ip: '::1' }))).toBe(true)
  })

  it('trusts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
    expect(isLoopbackWebhookRequest(makeReq({ ip: '::ffff:127.0.0.1' }))).toBe(true)
  })

  it('REFUSES a spoofed X-Forwarded-For when no proxy allow-list is set', () => {
    // This is the core MAJOR-1 regression: the previous implementation
    // accepted XFF unconditionally. We must reject it.
    expect(
      isLoopbackWebhookRequest(
        makeReq({ ip: '203.0.113.10', xff: '127.0.0.1' })
      )
    ).toBe(false)
  })

  it('REFUSES a spoofed X-Real-IP when no proxy allow-list is set', () => {
    expect(
      isLoopbackWebhookRequest(
        makeReq({ ip: '203.0.113.10', xRealIp: '127.0.0.1' })
      )
    ).toBe(false)
  })

  it('refuses when peer IP is missing and no allow-list is set', () => {
    // No req.ip + no allow-list means we cannot establish trust.
    expect(
      isLoopbackWebhookRequest(makeReq({ ip: null, xff: '127.0.0.1' }))
    ).toBe(false)
  })

  it('trusts XFF=127.0.0.1 ONLY when the direct peer is an allow-listed proxy', () => {
    process.env.WEBHOOK_TRUSTED_PROXY_IPS = '10.0.0.5'
    expect(
      isLoopbackWebhookRequest(makeReq({ ip: '10.0.0.5', xff: '127.0.0.1' }))
    ).toBe(true)
  })

  it('refuses XFF=127.0.0.1 when the peer is NOT in the allow-list', () => {
    process.env.WEBHOOK_TRUSTED_PROXY_IPS = '10.0.0.5'
    expect(
      isLoopbackWebhookRequest(makeReq({ ip: '203.0.113.10', xff: '127.0.0.1' }))
    ).toBe(false)
  })

  it('takes only the left-most XFF entry when peer is a trusted proxy', () => {
    // The "client" hop is the first entry; later hops are upstream proxies.
    process.env.WEBHOOK_TRUSTED_PROXY_IPS = '10.0.0.5'
    expect(
      isLoopbackWebhookRequest(
        makeReq({ ip: '10.0.0.5', xff: '203.0.113.10, 127.0.0.1' })
      )
    ).toBe(false)
  })
})

describe('warnMissingWebhookSecret', () => {
  const originalNodeEnv = process.env.NODE_ENV
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('returns true (refuse) and logs error in production', () => {
    process.env.NODE_ENV = 'production'
    const refuse = warnMissingWebhookSecret('crowdsec', 'CROWDSEC_WEBHOOK_SECRET')
    expect(refuse).toBe(true)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(String(errorSpy.mock.calls[0][0])).toContain('CROWDSEC_WEBHOOK_SECRET')
  })

  it('returns false (allow dev fallback) and logs warning in development', () => {
    process.env.NODE_ENV = 'development'
    const refuse = warnMissingWebhookSecret('wazuh', 'WAZUH_WEBHOOK_SECRET')
    expect(refuse).toBe(false)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(String(warnSpy.mock.calls[0][0])).toContain('WAZUH_WEBHOOK_SECRET')
  })
})
