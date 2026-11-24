import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, any>
const db = vi.hoisted(() => ({ bugs: [] as Row[], agents: [{ id: 'alpha-id', name: 'Alpha' }] as Row[], usage: [] as Row[], failUsage: false, failBugId: null as string | null, updates: 0 }))

// Evaluates the selection filter like the real query: equality, in, gte, lt, AND, OR, and a null check.
const matches = (b: Row, where: Row): boolean => Object.entries(where).every(([k, v]: [string, any]) => {
  if (k === 'OR') return v.some((w: Row) => matches(b, w))
  if (k === 'AND') return v.every((w: Row) => matches(b, w))
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(b[k])
    if ('gte' in v) return b[k] != null && b[k] >= v.gte
    if ('lt' in v) return b[k] != null && b[k] < v.lt
  }
  return v === null ? b[k] == null : b[k] === v
})

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findUnique: async ({ where }: any) => db.agents.find(a => a.name === where.name) ?? null },
    bug: {
      // orderBy [{ fixRequestedAt asc, nulls first }, { createdAt asc }]
      findFirst: async ({ where }: any) => db.bugs.filter(b => matches(b, where))
        .sort((a, b) => (a.fixRequestedAt?.getTime() ?? -Infinity) - (b.fixRequestedAt?.getTime() ?? -Infinity) || a.createdAt - b.createdAt)[0] ?? null,
      findMany: async ({ where }: any) => db.bugs.filter(b => matches(b, where)),
      update: async ({ where, data }: any) => { db.updates++; if (where.id === db.failBugId) throw new Error('db down'); Object.assign(db.bugs.find(b => b.id === where.id)!, data) },
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
  dispatcherConfig: () => ({ url: 'https://dispatcher.example.com', token: 't', repo: 'owner/name' }),
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
  db.bugs = []; db.usage = []; db.failUsage = false; db.failBugId = null; db.updates = 0; db.agents = [{ id: 'alpha-id', name: 'Alpha' }]
  client.configured = true; client.list.mockReset(); client.create.mockReset()
  client.list.mockResolvedValue(overview()); client.create.mockResolvedValue(accepted)
  vi.stubEnv('ORION_SELF_IMPROVEMENT', 'on')
  vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
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

describe('dispatcher answers that are not trusted', () => {
  it.each([
    ['a missing limit', { max_open: undefined }],
    ['a non-numeric count', { last_24h: 'x' }],
    ['not configured', { configured: false }],
  ])('sends nothing on %s', async (_n, over) => {
    db.bugs = [bug()]
    client.list.mockResolvedValue(overview(over))
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(client.create).not.toHaveBeenCalled()
  })
  it('names the missing variables once when the switch is on but the client is off', async () => {
    vi.resetModules()
    const { runSelfImprovement: fresh } = await import('./self-improvement')
    client.configured = false
    await fresh(NOW); await fresh(NOW)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/DISPATCHER_REQUESTS_URL.*DISPATCHER_REQUESTS_TOKEN.*DISPATCHER_REQUESTS_REPO/))
  })
  it('logs the HTTP status when the dispatcher cannot be read', async () => {
    client.list.mockResolvedValue({ ok: false, reason: 'error', status: 500 })
    await runSelfImprovement(NOW)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('(HTTP 500)'))
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
  it('backs off an invalid request for an hour without burning the bug, and logs the dispatcher text', async () => {
    const a = bug({ createdAt: hoursAgo(9) }), b = bug({ createdAt: hoursAgo(8) }); db.bugs = [a, b]
    client.create.mockResolvedValueOnce({ ok: false, reason: 'invalid', status: 400, detail: 'repo not allowed' })
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(a.fixRequestRef).toBeNull()
    expect(a.fixRequestedAt).toEqual(NOW)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('(HTTP 400): repo not allowed'))
    expect((await runSelfImprovement(new Date(NOW.getTime() + 60_000))).sent).toBe(b.id)
  })
  it('stores state "requested" for a 202 without a state', async () => {
    const b = bug(); db.bugs = [b]
    client.create.mockResolvedValue({ ok: true, outcome: 'accepted', request: { task_id: 't1', branch: 'fix/b', state: '' } })
    await runSelfImprovement(NOW)
    expect(b.fixState).toBe('requested')
  })
  it('puts a bug whose send failed behind the others for an hour', async () => {
    const a = bug({ createdAt: hoursAgo(9) }), b = bug({ createdAt: hoursAgo(8) }); db.bugs = [a, b]
    client.create.mockResolvedValueOnce({ ok: false, reason: 'error' })
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(a).toMatchObject({ fixRequestRef: null, fixRequestedAt: NOW })
    expect((await runSelfImprovement(new Date(NOW.getTime() + 60_000))).sent).toBe(b.id)
    expect(client.create.mock.calls.map(c => c[0].ref)).toEqual([a.id, b.id])
    client.create.mockClear()
    const later = new Date(NOW.getTime() + 2 * 3_600_000)
    db.bugs.forEach(x => { x.lastSeenAt = new Date(later.getTime() - 3_600_000) })
    expect((await runSelfImprovement(later)).sent).toBe(a.id) // an hour on, it is tried again
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
    expect(a).toMatchObject({ fixState: 'approved', fixPrUrl: 'https://git.example.com/pr/3', fixUsage: { [`task-${a.id}`]: usage() } })
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
    db.failBugId = a.id
    expect((await runSelfImprovement(NOW)).synced).toBe(1)
    expect(a.fixState).toBeNull()
    expect(b.fixState).toBe('running')
    db.failBugId = null
    expect((await runSelfImprovement(NOW)).synced).toBe(2)
    expect(a.fixState).toBe('running')
  })

  it('does not write a bug when nothing changed', async () => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b)]))
    await runSelfImprovement(NOW)
    expect(db.updates).toBe(1)
    b.fixUsage = JSON.parse(JSON.stringify(b.fixUsage)) // a JSON column does not keep key order
    b.fixUsage = Object.fromEntries(Object.entries(b.fixUsage).reverse())
    b.fixUsage[`task-${b.id}`] = Object.fromEntries(Object.entries(b.fixUsage[`task-${b.id}`]).reverse())
    await runSelfImprovement(NOW)
    expect(db.updates).toBe(1)
  })

  it('keeps one baseline per task when a ref has two requests, however often it runs', async () => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b]
    const old = remote(b, { task_id: 'old', created: hoursAgo(5).toISOString(), state: 'closed', usage: usage({ input_tokens: 400, output_tokens: 10 }) })
    const cur = remote(b, { task_id: 'new', created: hoursAgo(1).toISOString(), state: 'running' })
    client.list.mockResolvedValue(overview({ paused: true }, [cur, old]))
    for (let i = 0; i < 3; i++) await runSelfImprovement(NOW)
    expect(db.usage).toHaveLength(1)
    expect(db.usage[0].a.slice(2)).toEqual([115 + 415, 60, 'dispatcher'])
    expect(b).toMatchObject({ fixTaskId: 'new', fixState: 'running' })
    expect(Object.keys(b.fixUsage).sort()).toEqual(['new', 'old'])
    expect(db.updates).toBe(1)
  })

  it('ignores requests for another repo', async () => {
    const b = bug({ fixRequestRef: 'x' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b, { repo: 'other/repo', state: 'done' }), remote(b)]))
    await runSelfImprovement(NOW)
    expect(b.fixState).toBe('running')
    expect(db.usage).toHaveLength(1)
  })

  it('repairs a request that was accepted but never stored, and does not send it again', async () => {
    const b = bug(); db.bugs = [b] // POST timed out after the dispatcher accepted it
    client.list.mockResolvedValue(overview({ open: 1 }, [remote(b)]))
    const r = await runSelfImprovement(NOW)
    expect(r.sent).toBeNull()
    expect(b).toMatchObject({ fixRequestRef: b.id, fixTaskId: `task-${b.id}`, fixState: 'running' })
    client.list.mockResolvedValue(overview({}, [remote(b)]))
    await runSelfImprovement(NOW)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('logs once when a request ends without a merge', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'running' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(b, { state: 'closed' })]))
    await runSelfImprovement(NOW); await runSelfImprovement(NOW)
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('ended closed; not re-requested'))
  })

  it('looks Alpha up once per run, and warns once, however many requests grew', async () => {
    const a = bug({ fixRequestRef: 'x' }), b = bug({ fixRequestRef: 'x' }); db.bugs = [a, b]
    client.list.mockResolvedValue(overview({ paused: true }, [remote(a), remote(b)]))
    db.agents = []
    await runSelfImprovement(NOW)
    expect(console.warn).toHaveBeenCalledTimes(1)
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

  it('resolves once when a ref lists a merged and a newer closed request, run three times', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'approved' }); db.bugs = [b]
    const m = { ...merged(b), task_id: 'm', created: hoursAgo(5).toISOString() }
    client.list.mockResolvedValue(overview({ paused: true }, [m, remote(b, { task_id: 'c', created: hoursAgo(1).toISOString(), state: 'closed' })]))
    for (let i = 0; i < 3; i++) await runSelfImprovement(NOW)
    expect(b.evidence.filter((e: Row) => String(e.note).includes('fix merged'))).toHaveLength(0)
    const rows = db.usage.length // the "m" and "c" tasks, recorded once each in the first three runs
    expect(rows).toBe(1)
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b), remote(b, { task_id: 'c', created: hoursAgo(9).toISOString(), state: 'closed' })]))
    for (let i = 0; i < 3; i++) await runSelfImprovement(NOW)
    expect(b.evidence.filter((e: Row) => String(e.note).includes('fix merged'))).toHaveLength(1)
    expect(db.usage).toHaveLength(rows + 1) // only the newly listed task's usage, once
  })

  it('does not write or resolve again on a second run while the bug stays resolved', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'approved' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b)]))
    await runSelfImprovement(NOW)
    const updates = db.updates
    await runSelfImprovement(NOW)
    expect(db.updates).toBe(updates)
    expect(b.evidence).toHaveLength(2)
  })

  it('does not send a regressed bug again', async () => {
    const b = bug({ fixRequestRef: 'x', fixState: 'merged' }); db.bugs = [b] // reopened by self-diagnosis
    client.list.mockResolvedValue(overview({}, [merged(b)]))
    expect((await runSelfImprovement(NOW)).sent).toBeNull()
    expect(client.create).not.toHaveBeenCalled()
  })

  it('leaves a closed bug closed', async () => {
    const b = bug({ fixRequestRef: 'x', status: 'closed' }); db.bugs = [b]
    client.list.mockResolvedValue(overview({ paused: true }, [merged(b)]))
    await runSelfImprovement(NOW)
    expect(b.status).toBe('closed')
  })
})
