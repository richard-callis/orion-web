/**
 * Rate-limit bucket naming (SOC2 M6) and client IP extraction (SOC2 M1)
 */

import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { rateLimitBucket, normalizeRatePath } from './rate-limit-bucket'
import { getClientIpForRateLimit, getTrustedProxyCount } from './rate-limit-redis'

describe('rateLimitBucket', () => {
  it('shares one bucket for all chat writes regardless of conversation id', () => {
    const a = rateLimitBucket('/api/chat/conversations/clx1a2b3c4d5e6f7g8h9i0j1/stream', 'POST', '/api/chat')
    const b = rateLimitBucket('/api/chat/conversations/clz9y8x7w6v5u4t3s2r1q0p9/stream', 'POST', '/api/chat')
    const c = rateLimitBucket('/api/chat/conversations', 'POST', '/api/chat')
    expect(a).toBe('/api/chat')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('shares one bucket for task writes', () => {
    expect(rateLimitBucket('/api/tasks/clx1a2b3c4d5e6f7g8h9i0j1', 'PUT', '/api/tasks')).toBe('/api/tasks')
  })

  it('keeps reads per endpoint but collapses ids', () => {
    const events1 = rateLimitBucket('/api/tasks/clx1a2b3c4d5e6f7g8h9i0j1/events', 'GET', '/api/tasks')
    const events2 = rateLimitBucket('/api/tasks/clz9y8x7w6v5u4t3s2r1q0p9/events', 'GET', '/api/tasks')
    const list = rateLimitBucket('/api/tasks', 'GET', '/api/tasks')
    expect(events1).toBe('/api/tasks/:id/events')
    expect(events2).toBe(events1)
    expect(list).toBe('/api/tasks')
  })

  it('collapses ids on default-limit paths without merging distinct endpoints', () => {
    expect(rateLimitBucket('/api/environments/clx1a2b3c4d5e6f7g8h9i0j1/infrastructure', 'GET', null))
      .toBe('/api/environments/:id/infrastructure')
    expect(rateLimitBucket('/api/security/alerts', 'POST', null)).toBe('/api/security/alerts')
  })

  it('does not share buckets for writes under non-cost prefixes (e.g. webhooks)', () => {
    expect(rateLimitBucket('/api/webhooks/clx1a2b3c4d5e6f7g8h9i0j1', 'POST', '/api/webhooks')).toBe('/api/webhooks/:id')
  })
})

describe('normalizeRatePath', () => {
  it('recognises uuid, numeric and cuid segments but not route names', () => {
    expect(normalizeRatePath('/api/executions/11111111-2222-3333-4444-555555555555/review'))
      .toBe('/api/executions/:id/review')
    expect(normalizeRatePath('/api/evals/42')).toBe('/api/evals/:id')
    expect(normalizeRatePath('/api/monitoring/security/notification-channels')).toBe('/api/monitoring/security/notification-channels')
  })
})

describe('getClientIpForRateLimit', () => {
  afterEach(() => { delete process.env.TRUSTED_PROXY_COUNT })

  const req = (xff?: string) => new NextRequest('http://x/api/chat', {
    headers: xff ? { 'x-forwarded-for': xff } : {},
  })

  it('uses the proxy-appended (rightmost) entry by default, ignoring client-supplied entries', () => {
    expect(getClientIpForRateLimit(req('6.6.6.6, 1.2.3.4'))).toBe('1.2.3.4')
    expect(getClientIpForRateLimit(req('1.2.3.4'))).toBe('1.2.3.4')
  })

  it('a spoofed x-forwarded-for cannot change the bucket behind one proxy', () => {
    const real = getClientIpForRateLimit(req('1.2.3.4'))
    expect(getClientIpForRateLimit(req('9.9.9.9, 8.8.8.8, 1.2.3.4'))).toBe(real)
  })

  it('honours TRUSTED_PROXY_COUNT=2', () => {
    process.env.TRUSTED_PROXY_COUNT = '2'
    expect(getClientIpForRateLimit(req('6.6.6.6, 1.2.3.4, 10.0.0.2'))).toBe('1.2.3.4')
  })

  it('honours TRUSTED_PROXY_COUNT=0 by ignoring the header entirely', () => {
    process.env.TRUSTED_PROXY_COUNT = '0'
    expect(getTrustedProxyCount()).toBe(0)
    expect(getClientIpForRateLimit(req('6.6.6.6'))).toBe('unknown')
  })

  it('falls back to 1 for invalid values', () => {
    process.env.TRUSTED_PROXY_COUNT = 'abc'
    expect(getTrustedProxyCount()).toBe(1)
    process.env.TRUSTED_PROXY_COUNT = '-3'
    expect(getTrustedProxyCount()).toBe(1)
  })
})
