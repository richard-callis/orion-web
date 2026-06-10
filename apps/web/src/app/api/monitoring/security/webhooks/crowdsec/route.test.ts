/**
 * Tests for POST /api/monitoring/security/webhooks/crowdsec
 *
 * Guards webhook authentication:
 *  - valid HMAC signature + existing env → 200
 *  - missing signature → 401
 *  - wrong token → 401
 *  - missing envId query param → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'

// ── Prisma double ────────────────────────────────────────────────────────────
const environment_findUnique = vi.fn(async () => ({ id: 'env-1' } as unknown))
const securityEvent_create = vi.fn(async () => ({}))
const sourceHealth_upsert = vi.fn(async () => ({}))
const securityEvent_findFirst = vi.fn(async () => null as unknown)

vi.mock('@/lib/db', () => ({
  prisma: {
    environment: {
      findUnique: (...a: unknown[]) => environment_findUnique(a[0]),
    },
    securityEvent: {
      create: (...a: unknown[]) => securityEvent_create(a[0]),
      findFirst: (...a: unknown[]) => securityEvent_findFirst(a[0]),
    },
    sourceHealth: {
      upsert: (...a: unknown[]) => sourceHealth_upsert(a[0]),
    },
  },
}))

const SECRET = 'webhook-secret-123'

function sign(body: string, key = SECRET): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`
}

// Minimal valid CrowdSec alert payload
const validAlert = {
  decisions: [
    {
      id: 1,
      origin: 'crowdsec',
      type: 'ban',
      scope: 'Ip',
      value: '203.0.113.5',
      duration: '24h',
      scenario: 'crowdsecurity/ssh-bf',
      simulated: false,
    },
  ],
  source: { ip: '203.0.113.5', scope: 'Ip', value: '203.0.113.5' },
  start_at: new Date().toISOString(),
  stop_at: new Date().toISOString(),
  scenario: 'crowdsecurity/ssh-bf',
  scenario_hash: 'abc123',
  scenario_version: '0.0.1',
  capacity: -1,
  leakspeed: '0',
  simulated: false,
  events_count: 1,
  events: [],
  labels: null,
  machine_id: 'test-machine',
  uuid: `dedup-${Date.now()}`,
}

function buildReq(opts: {
  url: string
  body: unknown
  signature?: string | null
  contentLength?: number
}): NextRequest {
  const bodyStr = JSON.stringify(opts.body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(opts.contentLength ?? Buffer.byteLength(bodyStr)),
    'x-timestamp': new Date().toISOString(),
  }
  if (opts.signature !== null) {
    headers['x-signature'] = opts.signature ?? sign(bodyStr)
  }
  return new NextRequest(opts.url, {
    method: 'POST',
    headers,
    body: bodyStr,
  })
}

beforeEach(() => {
  process.env.CROWDSEC_WEBHOOK_SECRET = SECRET
  delete process.env.ENVIRONMENT_ID

  environment_findUnique.mockReset().mockResolvedValue({ id: 'env-1' })
  securityEvent_create.mockReset().mockResolvedValue({})
  sourceHealth_upsert.mockReset().mockResolvedValue({})
  securityEvent_findFirst.mockReset().mockResolvedValue(null)
})

// Import after mocks are set up
import { POST } from './route'

describe('POST /api/monitoring/security/webhooks/crowdsec', () => {
  it('returns 200 for a request with a valid HMAC signature and existing env', async () => {
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec?env=env-1',
      body: validAlert,
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { received: boolean }
    expect(body.received).toBe(true)
  })

  it('returns 401 when the signature header is absent', async () => {
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec?env=env-1',
      body: validAlert,
      signature: null,
    }))
    expect(res.status).toBe(401)
  })

  it('returns 401 when the signature is wrong (tampered body)', async () => {
    const bodyStr = JSON.stringify(validAlert)
    const tamperedSig = sign(bodyStr + 'TAMPERED')
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec?env=env-1',
      body: validAlert,
      signature: tamperedSig,
    }))
    expect(res.status).toBe(401)
  })

  it('returns 401 when the signature uses the wrong secret', async () => {
    const bodyStr = JSON.stringify(validAlert)
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec?env=env-1',
      body: validAlert,
      signature: sign(bodyStr, 'wrong-secret'),
    }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when the env query param is missing', async () => {
    // No ?env= and no ENVIRONMENT_ID in env
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec',
      body: validAlert,
    }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/env/i)
  })

  it('returns 404 when the environment does not exist in DB', async () => {
    environment_findUnique.mockResolvedValue(null)
    const res = await POST(buildReq({
      url: 'http://x/api/monitoring/security/webhooks/crowdsec?env=nonexistent',
      body: validAlert,
    }))
    expect(res.status).toBe(404)
  })
})
