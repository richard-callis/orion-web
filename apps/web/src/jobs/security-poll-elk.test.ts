/**
 * Regression test for PR #407 BLOCK-1: pollers must not advance the
 * watermark on a batch where every event fails to insert. The previous
 * implementation bumped lastWatermark to the newest *seen* event, so a
 * batch of permanently un-parseable events would silently be skipped on
 * every subsequent poll.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted runs BEFORE the import block (which is itself hoisted by vitest).
// ELK_URL is captured at module load time inside security-poll-elk.ts, so we
// must set it before that module is imported below.
vi.hoisted(() => {
  process.env.ELK_URL = 'http://elk:9200'
})

// In-memory prisma double — captured at module evaluation time. The mock
// factory below is hoisted by vitest, so we keep references in module
// scope to assert/configure them from the test body.
const upsertCalls: Array<{
  update: Record<string, unknown>
  create: Record<string, unknown>
}> = []
let createImpl: () => Promise<unknown> = async () => ({})
let findUniqueImpl: () => Promise<unknown> = async () => null
let countImpl: () => Promise<number> = async () => 0

vi.mock('@/lib/db', () => ({
  prisma: {
    sourceHealth: {
      findUnique: vi.fn(() => findUniqueImpl()),
      upsert: vi.fn(({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        upsertCalls.push({ update, create })
        return Promise.resolve({})
      }),
    },
    securityEvent: {
      count: vi.fn(() => countImpl()),
      create: vi.fn((args: { data: unknown }) => createImpl().then(() => args)),
    },
  },
}))

// Re-export the real implementations from the relative paths so vitest can
// resolve them — the `@/...` aliases would also work via the next.js path
// resolver, but the test runner's resolver doesn't honour them.
vi.mock('@/lib/security/normalize/elk', async () => {
  return await import('../lib/security/normalize/elk')
})
vi.mock('@/lib/security/types', async () => {
  return await import('../lib/security/types')
})

// The poller captures ELK_URL at module-load time, so it must be set BEFORE
// the runElkPoller import below.
process.env.ELK_URL = 'http://elk:9200'

import { runElkPoller } from './security-poll-elk'

const fetchStub = vi.fn()

describe('runElkPoller (PR #407 BLOCK-1 watermark)', () => {
  beforeEach(() => {
    upsertCalls.length = 0
    createImpl = async () => ({})
    findUniqueImpl = async () => null
    countImpl = async () => 0
    fetchStub.mockReset()
    ;(global as { fetch?: unknown }).fetch = fetchStub
    process.env.ELK_URL = 'http://elk:9200'
  })

  it('does NOT advance watermark when every event fails to insert', async () => {
    // ELK returns two events that will fail Zod parse — wrong shape.
    const hits = [
      { _source: { '@timestamp': '2026-05-20T10:00:00Z', message: 'a', anomaly_score: 'not-a-number' as unknown as number } },
      { _source: { '@timestamp': '2026-05-20T10:01:00Z', message: 'b', anomaly_score: 'not-a-number' as unknown as number } },
    ]
    fetchStub.mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { hits } }),
    })
    // Force every create() to throw so eventsInserted stays at 0 even if
    // normalize+Zod somehow accept the row (defensive).
    createImpl = async () => { throw new Error('forced insert failure') }

    const res = await runElkPoller('env-1')
    expect(res.eventsFound).toBe(2)
    expect(res.eventsInserted).toBe(0)
    // Critical assertion: the upsert sent to source health must NOT include
    // a lastWatermark on the update path.
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].update).not.toHaveProperty('lastWatermark')
    expect(res.watermark).toBeNull()
  })

  it('does not advance watermark when ELK returns an empty batch', async () => {
    fetchStub.mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    })

    const res = await runElkPoller('env-1')
    expect(res.eventsFound).toBe(0)
    expect(res.eventsInserted).toBe(0)
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].update).not.toHaveProperty('lastWatermark')
    expect(res.watermark).toBeNull()
  })

  it('does not advance watermark when ELK fetch itself fails', async () => {
    fetchStub.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })

    const res = await runElkPoller('env-1')
    expect(res.eventsFound).toBe(0)
    expect(res.eventsInserted).toBe(0)
    expect(res.errors.length).toBeGreaterThan(0)
    // upsert path not reached when the query itself errors out.
  })
})
