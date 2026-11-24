import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, any>
const db = vi.hoisted(() => ({ bugs: [] as Row[], agents: [{ id: 'alpha-id', name: 'Alpha' }] as Row[], usage: [] as Row[], failUsage: false }))

// Evaluates the selection filter like the real query: equality, in, gte, OR, and a null check.
const matches = (b: Row, where: Row): boolean => Object.entries(where).every(([k, v]: [string, any]) => {
  if (k === 'OR') return v.some((w: Row) => matches(b, w))
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(b[k])
    if ('gte' in v) return b[k] != null && b[k] >= v.gte
  }
  return v === null ? b[k] == null : b[k] === v
})

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findUnique: async ({ where }: any) => db.agents.find(a => a.name === where.name) ?? null },
    bug: {
      findFirst: async ({ where }: any) => db.bugs.filter(b => matches(b, where)).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
      findMany: async ({ where }: any) => db.bugs.filter(b => matches(b, where)),
      update: async ({ where, data }: any) => { Object.assign(db.bugs.find(b => b.id === where.id)!, data) },
    },
  },
}))
vi.mock('@/lib/token-budget', () => ({
  recordTokenUsage: async (...a: any[]) => { if (db.failUsage) throw new Error('db down'); db.usage.push({ a }) },
}))
const client = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), configured: true }))
vi.mock('@/lib/dispatcher-requests', () => ({
  isDispatcherConfigured: () => client.configured,
  listRequests: client.list,
  createRequest: client.create,
}))

import { runSelfImprovement } from './self-improvement'

const NOW = new Date('2026-11-24T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
let n = 0
const bug = (over: Row = {}): Row => ({
  id: `bug${++n}`, title: 'Jobs: failed', description: 'It failed', severity: 'high', status: 'open', area: 'Jobs', source: 'self-diagnosis',
  occurrences: 1, createdAt: hoursAgo(10 - n / 100), lastSeenAt: hoursAgo(1), evidence: [{ ref: 'r1', at: hoursAgo(1).toISOString(), excerpt: 'boom' }],
  fixRequestRef: null, fixUsage: null, fixState: null, fixPrUrl: null, fixRequestedAt: null, ...over,
})
const overview = (over: Row = {}, requests: Row[] = []) => ({
  ok: true, overview: { configured: true, paused: false, last_24h: 0, max_per_day: 3, open: 0, max_open: 2, usd_last_24h: 0, max_usd_per_day: 20, usage_last_24h: {}, requests, ...over },
})
const usage = (over: Row = {}) => ({ cost_usd: 1, input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, attempts: 1, ...over })
const remote = (b: Row, over: Row = {}) => ({ ref: b.id, repo: 'owner/name', branch: `fix/${b.id}`, created: NOW.toISOString(), task_id: `task-${b.id}`, state: 'running', pr_url: null, gate: null, usage: usage(), ...over })
const accepted = { ok: true, outcome: 'accepted', request: { task_id: 't1', branch: 'fix/b', state: 'queued' } }

beforeEach(() => {
  db.bugs = []; db.usage = []; db.failUsage = false; db.agents = [{ id: 'alpha-id', name: 'Alpha' }]
  client.configured = true; client.list.mockReset(); client.create.mockReset()
  client.list.mockResolvedValue(overview()); client.create.mockResolvedValue(accepted)
  vi.stubEnv('ORION_SELF_IMPROVEMENT', 'on')
  vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('switches', () => {
  it('does nothing when ORION_SELF_IMPROVEMENT is not on', async () => {
    vi.stubEnv('ORION_SELF_IMPROVEMENT', 'off'); db.bugs = [bug()]
    expect((await runSelfImprovement(NOW)).skipped).toBe('off')
    expect(client.list).not.toHaveBeenCalled()
  })
  it('does nothing when the dispatcher client is not configured', async () => {
    client.configured = false; db.bugs = [bug()]
    expect((await runSelfImprovement(NOW)).skipped).toBe('off')
    expect(client.list).not.toHaveBeenCalled()
  })
  it('does nothing more when the dispatcher cannot be read', async () => {
    client.list.mockResolvedValue({ ok: false, reason: 'error' }); db.bugs = [bug()]
    expect((await runSelfImprovement(NOW)).skipped).toBe('error')
    expect(client.create).not.toHaveBeenCalled()
  })
})

describe('selection', () => {
  it('sends the oldest eligible bug, once, with redacted capped evidence', async () => {
    const newer = bug({ createdAt: hoursAgo(2) })
    const secret = bug({ createdAt: hoursAgo(5), evidence: [{ ref: 'r', at: 'x', excerpt: `token=abc123 ${'x'.repeat(30000)}` }], description: 'd'.repeat(9000) })
    db.bugs = [newer, secret]
    expect((await runSelfImprovement(NOW)).sent).toBe(secret.id)
    expect(client.create).toHaveBeenCalledTimes(1)
    const body = client.create.mock.calls[0][0]
    expect(body.ref).toBe(secret.id)
    expect(body.evidence).not.toContain('abc123')
    expect(body.evidence.length).toBeLessThanOrEqual(20000)
    expect(body.problem.length).toBeLessThanOrEqual(8000)
    expect(secret).toMatchObject({ fixRequestRef: secret.id, fixTaskId: 't1', fixBranch: 'fix/b', fixState: 'queued', fixRequestedAt: NOW })
    expect(newer.fixRequestRef).toBeNull()
  })

  it('includes area, severity and occurrences in the problem', async () => {
    db.bugs = [bug({ severity: 'critical', occurrences: 7 })]
    await runSelfImprovement(NOW)
    expect(client.create.mock.calls[0][0].problem).toContain('Area: Jobs\nSeverity: critical\nOccurrences: 7')
  })

  it.each([
    ['low severity', { severity: 'low', occurrences: 9 }],
    ['medium with fewer than 3 occurrences', { severity: 'medium', occurrences: 2 }],
    ['triaged', { status: 'triaged' }],
    ['in progress', { status: 'in_progress' }],
    ['resolved', { status: 'resolved' }],
    ['not seen in 24 h', { lastSeenAt: hoursAgo(25) }],
    ['already requested', { fixRequestRef: 'x' }],
    ['filed by a person', { source: null }],
  ])('skips a bug that is %s', async (_n, over) => {
    db.bugs = [bug(over)]
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(client.create).not.toHaveBeenCalled()
  })

  it.each([{ severity: 'high' }, { severity: 'critical' }, { severity: 'medium', occurrences: 3 }])('sends %o', async over => {
    db.bugs = [bug(over)]
    expect((await runSelfImprovement(NOW)).sent).toBe(db.bugs[0].id)
  })
})

describe('limits', () => {
  it.each([
    ['paused', { paused: true }],
    ['open limit', { open: 2 }],
    ['daily limit', { last_24h: 3 }],
    ['cost limit', { usd_last_24h: 20 }],
  ])('sends nothing at the %s but still syncs', async (_n, over) => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b, bug()]
    client.list.mockResolvedValue(overview(over, [remote(b)]))
    const r = await runSelfImprovement(NOW)
    expect(r.sent).toBeNull()
    expect(r.synced).toBe(1)
    expect(client.create).not.toHaveBeenCalled()
    expect(b.fixState).toBe('running')
  })
})

describe('send outcomes', () => {
  it('stores the existing task and branch on 409', async () => {
    const b = bug(); db.bugs = [b]
    client.create.mockResolvedValue({ ok: true, outcome: 'duplicate', request: { task_id: 'old', branch: 'fix/old', pr_url: 'https://git.example.com/pr/2' } })
    await runSelfImprovement(NOW)
    expect(b).toMatchObject({ fixRequestRef: b.id, fixTaskId: 'old', fixBranch: 'fix/old', fixPrUrl: 'https://git.example.com/pr/2' })
  })
  it.each(['limit', 'paused'])('stops without marking the bug on %s', async reason => {
    const b = bug(); db.bugs = [b]
    client.create.mockResolvedValue({ ok: false, reason, status: 429 })
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(b.fixRequestRef).toBeNull()
  })
  it('marks an invalid bug rejected so it does not block the queue', async () => {
    const b = bug(); db.bugs = [b]
    client.create.mockResolvedValue({ ok: false, reason: 'invalid', status: 400 })
    await runSelfImprovement(NOW)
    expect(b).toMatchObject({ fixRequestRef: b.id, fixState: 'rejected' })
  })
})

describe('sync and usage', () => {
  it('copies gate state (else task state), PR url and usage', async () => {
    const a = bug({ fixRequestRef: 'x' }), b = bug({ fixRequestRef: 'x' }); db.bugs = [a, b]
    client.list.mockResolvedValue(overview({ paused: true }, [
      remote(a, { state: 'done', gate: { state: 'approved', round: 1, owner_merges: true }, pr_url: 'https://git.example.com/pr/3' }),
      remote(b),
      { ...remote(bug()), ref: 'unknown-bug' },
    ]))
    expect((await runSelfImprovement(NOW)).synced).toBe(2)
    expect(a).toMatchObject({ fixState: 'approved', fixPrUrl: 'https://git.example.com/pr/3', fixUsage: usage() })
    expect(b.fixState).toBe('running')
  })

  it('records usage deltas under Alpha as "dispatcher" and never twice', async () => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b)]))
    await runSelfImprovement(NOW)
    expect(db.usage.map(u => u.a)).toEqual([['alpha-id', null, 115, 50, 'dispatcher']])
    await runSelfImprovement(NOW) // unchanged → nothing new
    expect(db.usage).toHaveLength(1)
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b, { usage: usage({ input_tokens: 130, output_tokens: 80, cache_read_input_tokens: 5 }) })]))
    await runSelfImprovement(NOW)
    expect(db.usage.map(u => u.a)).toEqual([['alpha-id', null, 115, 50, 'dispatcher'], ['alpha-id', null, 30, 30, 'dispatcher']])
  })

  it('keeps the baseline when usage could not be recorded, so it is caught up later', async () => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b)]))
    db.agents = []
    await runSelfImprovement(NOW)
    expect(db.usage).toHaveLength(0)
    expect(b.fixUsage).toBeNull()
    db.agents = [{ id: 'alpha-id', name: 'Alpha' }]
    await runSelfImprovement(NOW)
    expect(db.usage.map(u => u.a)).toEqual([['alpha-id', null, 115, 50, 'dispatcher']])
  })

  it('keeps going when one request fails to sync', async () => {
    const a = bug({ fixRequestRef: 'x' }), b = bug({ fixRequestRef: 'x' }); db.bugs = [a, b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(a), remote(b)]))
    db.failUsage = true
    expect((await runSelfImprovement(NOW)).synced).toBe(0)
    db.failUsage = false
    expect((await runSelfImprovement(NOW)).synced).toBe(2)
  })
})

describe('resolve on merge', () => {
  const merged = (b: Row) => remote(b, { gate: { state: 'merged', round: 1, owner_merges: true }, pr_url: 'https://git.example.com/pr/4' })

  it('resolves the bug once, with a note in its evidence', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'approved' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b)]))
    await runSelfImprovement(NOW)
    expect(b.status).toBe('resolved')
    expect(b.evidence[0].note).toContain('fix merged: https://git.example.com/pr/4')
    expect(b.evidence).toHaveLength(2)
  })

  it('does not resolve again after self-diagnosis reopened it', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'approved' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b)]))
    await runSelfImprovement(NOW)
    b.status = 'open' // regressed
    await runSelfImprovement(NOW)
    expect(b.status).toBe('open')
    expect(b.evidence).toHaveLength(2)
  })

  it('leaves a closed bug closed', async () => {
    const b = bug({ fixRequestRef: 'x', status: 'closed' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b)]))
    await runSelfImprovement(NOW)
    expect(b.status).toBe('closed')
  })
})
