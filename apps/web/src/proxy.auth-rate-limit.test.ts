/**
 * Proxy: credential endpoints under the public /api/auth prefix are rate-limited
 * per IP (they used to skip rate limiting entirely); next-auth's polled GETs and
 * other public paths are not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { counts, calls } = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as Array<{ key: string; max: number }>,
}))

vi.mock('./lib/rate-limit-redis', () => ({
  getClientIpForRateLimit: (req: NextRequest) => req.headers.get('x-test-ip') ?? '203.0.113.9',
  rateLimitRedis: vi.fn(async (key: string, max: number, windowMs: number) => {
    calls.push({ key, max })
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    return { allowed: n <= max, remaining: Math.max(0, max - n), limit: max, resetAt: new Date(Date.now() + windowMs) }
  }),
}))
vi.mock('./lib/security/crowdsec-bouncer', () => ({ isIpBlocked: vi.fn(async () => false) }))
vi.mock('./lib/session-token', () => ({ getSessionToken: vi.fn(async () => null) }))

import { proxy } from './proxy'
import { AUTH_CREDENTIAL_LIMIT, isAuthCredentialRequest } from './lib/auth-rate-limit'

const req = (path: string, method = 'GET', ip?: string) =>
  new NextRequest(`http://localhost${path}`, { method, headers: ip ? { 'x-test-ip': ip } : {} })

beforeEach(() => { counts.clear(); calls.length = 0 })

describe('isAuthCredentialRequest', () => {
  it('matches credential POSTs only', () => {
    expect(isAuthCredentialRequest('/api/auth/callback/credentials', 'POST')).toBe(true)
    expect(isAuthCredentialRequest('/api/auth/totp-login', 'post')).toBe(true)
    expect(isAuthCredentialRequest('/api/auth/mfa/verify', 'POST')).toBe(true)
    expect(isAuthCredentialRequest('/api/auth/totp/verify/', 'POST')).toBe(true)
    expect(isAuthCredentialRequest('/api/auth/callback/credentials', 'GET')).toBe(false)
    expect(isAuthCredentialRequest('/api/auth/session', 'GET')).toBe(false)
    expect(isAuthCredentialRequest('/api/auth/csrf', 'GET')).toBe(false)
    expect(isAuthCredentialRequest('/api/auth/signout', 'POST')).toBe(false)
  })
})

describe('proxy credential rate limit', () => {
  it('returns 429 once login POSTs exceed the limit', async () => {
    const statuses: number[] = []
    for (let i = 0; i < AUTH_CREDENTIAL_LIMIT.maxRequests + 1; i++) {
      statuses.push((await proxy(req('/api/auth/callback/credentials', 'POST'))).status)
    }
    expect(statuses.slice(0, AUTH_CREDENTIAL_LIMIT.maxRequests).every(s => s !== 429)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })

  it('shares one bucket across credential endpoints (no per-endpoint quota to rotate through)', async () => {
    for (let i = 0; i < AUTH_CREDENTIAL_LIMIT.maxRequests; i++) {
      await proxy(req(i % 2 ? '/api/auth/totp-login' : '/api/auth/mfa/verify', 'POST'))
    }
    expect((await proxy(req('/api/auth/callback/credentials', 'POST'))).status).toBe(429)
    expect(calls.every(c => c.key.endsWith(`:${AUTH_CREDENTIAL_LIMIT.bucket}`))).toBe(true)
  })

  it('keys per client IP', async () => {
    for (let i = 0; i < AUTH_CREDENTIAL_LIMIT.maxRequests + 1; i++) await proxy(req('/api/auth/callback/credentials', 'POST', '198.51.100.1'))
    expect((await proxy(req('/api/auth/callback/credentials', 'POST', '198.51.100.2'))).status).not.toBe(429)
  })

  it('never limits the polled session/csrf/providers GETs', async () => {
    for (let i = 0; i < 50; i++) {
      for (const p of ['/api/auth/session', '/api/auth/csrf', '/api/auth/providers']) {
        expect((await proxy(req(p))).status).not.toBe(429)
      }
    }
    expect(calls).toHaveLength(0)
  })

  it('leaves other public paths unaffected', async () => {
    for (let i = 0; i < 20; i++) expect((await proxy(req('/login'))).status).not.toBe(429)
    expect((await proxy(req('/api/health'))).status).not.toBe(429)
    expect(calls.some(c => c.key.endsWith(`:${AUTH_CREDENTIAL_LIMIT.bucket}`))).toBe(false)
  })
})
