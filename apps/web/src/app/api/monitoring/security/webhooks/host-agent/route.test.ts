/**
 * POST /api/monitoring/security/webhooks/host-agent — envelope parsing.
 * A body that is valid JSON but not an object (e.g. `null`) must be a 400,
 * not a crash while destructuring the envelope.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({ prisma: {} }))
vi.mock('@/lib/security/webhook-auth', () => ({
  checkWebhookBodySize: () => ({ ok: true }),
  WEBHOOK_MAX_BODY_BYTES: 1_000_000,
  verifyWebhookHmac: vi.fn(() => false),
  wasAlreadyProcessed: vi.fn(async () => false),
  shouldAcceptUnauthenticated: vi.fn(() => false),
  warnMissingWebhookSecret: vi.fn(() => true),
}))

import { POST } from './route'

const post = (body: string) =>
  POST(new NextRequest('http://x/api/monitoring/security/webhooks/host-agent', {
    method: 'POST', body, headers: { 'content-length': String(body.length) },
  }))

describe('host-agent webhook envelope', () => {
  it.each(['null', '42', '"str"'])('rejects non-object JSON body %s with 400', async body => {
    const res = await post(body)
    expect(res.status).toBe(400)
  })

  it('still rejects invalid JSON with 400', async () => {
    expect((await post('{not json')).status).toBe(400)
  })
})
