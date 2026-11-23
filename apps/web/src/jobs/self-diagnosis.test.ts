import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, any>
const db = vi.hoisted(() => ({
  bugs: [] as Row[],
  settings: new Map<string, unknown>(),
  backgroundJobs: [] as Row[],
  jobRuns: [] as Row[],
  sourceHealth: [] as Row[],
  envSourceHealth: [] as Row[],
  createHook: null as null | ((data: Row) => void),
  failSources: false,
}))

// Honours the time window (gte/lte on any field), the single-key orderBy and take, like the real query.
const query = (rows: Row[], { where = {}, orderBy, take }: any) => {
  if (db.failSources) throw new Error('db down')
  const field = Object.keys(orderBy ?? {})[0]
  return rows
    .filter(r => Object.entries(where).every(([k, v]: [string, any]) => v?.gte === undefined || (r[k] >= v.gte && r[k] <= v.lte)))
    .sort((a, b) => (field ? a[field].getTime() - b[field].getTime() : 0))
    .slice(0, take)
}

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findUnique: async ({ where }: any) => (db.settings.has(where.key) ? { value: db.settings.get(where.key) } : null),
      upsert: async ({ where, create }: any) => { db.settings.set(where.key, create.value) },
    },
    backgroundJob: { findMany: async (q: any) => query(db.backgroundJobs, q) },
    jobRun: { findMany: async (q: any) => query(db.jobRuns, q) },
    sourceHealth: { findMany: async () => db.sourceHealth },
    environmentSourceHealth: { findMany: async () => { if (db.failSources) throw new Error('db down'); return db.envSourceHealth } },
    bug: {
      findMany: async ({ where }: any) => db.bugs.filter(b => where.fingerprint.in.includes(b.fingerprint)),
      create: async ({ data }: any) => { db.createHook?.(data); db.bugs.push({ id: `bug${db.bugs.length}`, createdAt: new Date(), ...data }) },
      update: async ({ where, data }: any) => {
        const b = db.bugs.find(x => x.id === where.id)!
        for (const [k, v] of Object.entries(data)) b[k] = v
      },
    },
  },
}))

import { runSelfDiagnosis, MAX_NEW_BUGS, MAX_EVIDENCE, severityFor } from './self-diagnosis'
import { MAX_SIGNALS } from './self-diagnosis-sources'
import { normalizeMessage, fingerprintOf, redact, makeSignal } from './self-diagnosis-text'

const NOW = new Date('2026-11-23T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

let seq = 0
const failedJob = (over: Row = {}): Row => ({
  id: `job${++seq}`, type: 'storage-bootstrap', title: 'Bootstrap storage', status: 'failed',
  logs: ['starting', 'pod web-7f9c8d6b5-x2k4q crashed'], updatedAt: minsAgo(5), completedAt: minsAgo(5), ...over,
})
const failedRun = (over: Row = {}): Row => ({
  id: `run${++seq}`, source: 'schedule', sourceName: 'Nightly report', status: 'failed',
  errorMessage: 'timeout after 30s', startedAt: minsAgo(6), finishedAt: minsAgo(5), ...over,
})

beforeEach(() => {
  seq = 0
  db.bugs.length = db.backgroundJobs.length = db.jobRuns.length = db.sourceHealth.length = db.envSourceHealth.length = 0
  db.settings.clear()
  db.createHook = null
  db.failSources = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('normalization and fingerprints', () => {
  it('collapses ids, numbers, timestamps, IPs and quoted values', () => {
    const a = 'Job 123 failed at 2026-11-23T10:00:00Z for 10.0.0.5:8080 id=3f2504e0-4f89-11d3-9a0c-0305e82c3301 "alpha"'
    const b = 'Job 987 failed at 2026-11-22 01:02:03 for 10.0.0.77:9090 id=6ba7b810-9dad-11d1-80b4-00c04fd430c8 "beta"'
    expect(normalizeMessage(a)).toBe(normalizeMessage(b))
    expect(normalizeMessage('row clx1abcdefghijklmnopqrstu and deadbeef0123')).toBe('row <id> and <hex>')
  })

  it('keeps apostrophes in words and different faults apart', () => {
    expect(normalizeMessage("can't connect, can't retry")).toBe("can't connect, can't retry")
    const f = (m: string) => fingerprintOf('k', normalizeMessage(m))
    expect(f('connection refused to 10.0.0.1')).toBe(f('connection refused to 10.0.0.2'))
    expect(f('connection refused')).not.toBe(f('permission denied'))
    expect(fingerprintOf('a', 'x')).not.toBe(fingerprintOf('b', 'x'))
  })
})

describe('redaction', () => {
  it('removes secrets from untrusted text', () => {
    const blob = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2'
    const out = redact([
      'Authorization: Bearer abc.def-123', 'password=hunter2', 'api_key=sk-live-999', 'token: s3cr3t',
      'postgres://admin:p4ss@db.example.com:5432/orion', `blob ${blob}`, 'GATEWAY_TOKEN=zzz',
      '{"password":"hunter3"}', 'GATEWAY_TOKEN: zzz2', 'access_token: abc123', 'client_secret: abc124',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    ].join('\n'))
    for (const s of ['abc.def-123', 'hunter2', 'sk-live-999', 's3cr3t', 'p4ss', blob, 'zzz', 'hunter3', 'zzz2', 'abc123', 'abc124', 'dXNlcjpwYXNzd29yZA']) expect(out).not.toContain(s)
    expect(out).toContain('db.example.com')
  })

  it('leaves ordinary paths alone and caps excerpts at 2000 chars', () => {
    expect(redact('at /usr/lib/node_modules/some-package-with-a-long-name/dist/index.js:10')).toContain('some-package')
    const s = makeSignal({ kind: 'k', area: 'a', text: 'x', excerpt: 'y'.repeat(5000), ref: 'r', at: NOW, windowed: true })
    expect(s.excerpt).toHaveLength(2000)
  })

  it('strips NUL and control characters', () => {
    const s = makeSignal({ kind: 'k', area: 'a', text: 'bad\u0000byte', excerpt: 'x\u0001y', ref: 'r', at: NOW, windowed: true })
    expect(s.message).toBe('badbyte')
    expect(s.excerpt).toBe('xy')
  })

  it('never stores a secret in a Bug', async () => {
    db.jobRuns.push(failedRun({ errorMessage: 'login failed password=hunter2 via redis://u:pw@cache.example.com' }))
    await runSelfDiagnosis(NOW)
    expect(JSON.stringify(db.bugs)).not.toMatch(/hunter2|u:pw/)
  })
})

describe('runSelfDiagnosis', () => {
  it('creates one bug for the same fault on different rows', async () => {
    // Random pod-name suffixes are not normalized: both rows name the same pod.
    db.backgroundJobs.push(failedJob(), failedJob({ logs: ['pod web-7f9c8d6b5-x2k4q crashed'] }))
    db.jobRuns.push(failedRun(), failedRun({ errorMessage: 'timeout after 45s' }), failedRun({ errorMessage: 'disk full' }))
    const r = await runSelfDiagnosis(NOW)
    expect(r).toMatchObject({ created: 3, updated: 0 })
    const bug = db.bugs.find(b => b.area === 'storage-bootstrap')!
    expect(bug).toMatchObject({
      source: 'self-diagnosis', reportedBy: 'orion', status: 'open', occurrences: 2, severity: 'low',
    })
    expect(bug.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(bug.evidence).toHaveLength(2)
    expect(db.bugs.find(b => b.area === 'Nightly report' && b.occurrences === 2)).toBeTruthy()
  })

  it('looks back 24 h on the first run, then from the watermark', async () => {
    db.jobRuns.push(failedRun(), failedRun({ errorMessage: 'too old', finishedAt: minsAgo(25 * 60) }))
    await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(1)
    expect(db.settings.get('self-diagnosis.watermark')).toBe(minsAgo(2).toISOString())
    const again = await runSelfDiagnosis(new Date(NOW.getTime() + 600_000))
    expect(again).toMatchObject({ created: 0, updated: 0 }) // same row re-read: no double count
    expect(db.bugs[0].occurrences).toBe(1)
  })

  it('bumps occurrences, appends evidence within the cap and raises severity', async () => {
    db.jobRuns.push(failedRun())
    await runSelfDiagnosis(NOW)
    for (let i = 0; i < 12; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(1.5 - i / 10) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.updated).toBe(1)
    const bug = db.bugs[0]
    expect(bug.occurrences).toBe(13)
    expect(bug.evidence).toHaveLength(MAX_EVIDENCE)
    expect(bug.severity).toBe('medium')
  })

  it('reopens resolved and closed bugs with a regression note, keeps triaged and in_progress', async () => {
    for (let i = 0; i < 4; i++) db.jobRuns.push(failedRun({ errorMessage: `fault kind ${'abcd'[i]}-x` }))
    await runSelfDiagnosis(NOW)
    const statuses = ['resolved', 'closed', 'triaged', 'in_progress']
    db.bugs.forEach((b, i) => { b.status = statuses[i] })
    db.jobRuns.length = 0
    for (let i = 0; i < 4; i++) db.jobRuns.push(failedRun({ errorMessage: `fault kind ${'abcd'[i]}-x`, finishedAt: minsAgo(1) }))
    await runSelfDiagnosis(NOW)
    expect(db.bugs.map(b => b.status)).toEqual(['open', 'open', 'triaged', 'in_progress'])
    expect(db.bugs[0].evidence.some((e: Row) => e.note === 'regressed after being resolved')).toBe(true)
    expect(db.bugs[0].description).toContain('after being resolved')
    expect(db.bugs[2].evidence.some((e: Row) => e.note)).toBe(false)
  })

  it('files down heartbeat sources once per source and does not re-count the same outage', async () => {
    const stale = minsAgo(60)
    db.sourceHealth.push({ id: 's1', source: 'host-agent', environmentId: null, lastSeenAt: stale, staleAfterMs: 60_000 })
    db.sourceHealth.push({ id: 's2', source: 'k8s_events', environmentId: null, lastSeenAt: minsAgo(1), staleAfterMs: 600_000 })
    db.sourceHealth.push({ id: 's3', source: 'poller', environmentId: null, lastSeenAt: minsAgo(8), staleAfterMs: 300_000 }) // stale, not down
    db.envSourceHealth.push(
      { id: 'e1', source: 'falco', environmentId: 'env1', lastSeenAt: stale, staleAfterMs: 300_000 },
      { id: 'e2', source: 'falco', environmentId: 'env2', lastSeenAt: minsAgo(70), staleAfterMs: 300_000 },
    )
    await runSelfDiagnosis(NOW)
    expect(db.bugs.map(b => b.area).sort()).toEqual(['falco', 'host-agent'])
    expect(db.bugs.every(b => b.severity === 'high')).toBe(true)
    expect(db.bugs.find(b => b.area === 'falco')!.evidence[0].excerpt).toMatch(/env1[\s\S]*env2|env2[\s\S]*env1/)
    for (let i = 1; i <= 15; i++) await runSelfDiagnosis(new Date(NOW.getTime() + i * 1000))
    expect(db.bugs.map(b => b.occurrences)).toEqual([1, 1])
  })

  it('does not file event-driven sources that are merely quiet', async () => {
    for (const source of ['crowdsec', 'wazuh', 'gateway_audit']) {
      db.sourceHealth.push({ id: source, source, environmentId: null, lastSeenAt: minsAgo(600), staleAfterMs: 300_000 })
    }
    await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(0)
  })

  it('caps new bugs per run and holds the watermark back so the rest follows', async () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < MAX_NEW_BUGS + 5; i++) {
      db.jobRuns.push(failedRun({ errorMessage: `distinct fault ${letters[i % 26]}${letters[Math.floor(i / 26)]}x`, finishedAt: minsAgo(30 - i / 10) }))
    }
    const r = await runSelfDiagnosis(NOW)
    expect(r.created).toBe(MAX_NEW_BUGS)
    expect(r.skipped).toBe(5)
    expect(console.warn).toHaveBeenCalled()
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThanOrEqual(minsAgo(30 - MAX_NEW_BUGS / 10).getTime())
    const next = await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(MAX_NEW_BUGS + 5)
    expect(next.skipped).toBe(0)
  })

  it('caps signals per run and records the rest next run', async () => {
    for (let i = 0; i < MAX_SIGNALS; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(30 - i / 100) }))
    for (let i = 0; i < 10; i++) db.backgroundJobs.push(failedJob({ completedAt: minsAgo(1) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.signals).toBe(MAX_SIGNALS)
    expect(console.warn).toHaveBeenCalled()
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThanOrEqual(minsAgo(1).getTime())
    expect(db.bugs).toHaveLength(1)
    await runSelfDiagnosis(NOW)
    expect(db.bugs.find(b => b.area === 'storage-bootstrap')!.occurrences).toBe(10)
    expect(db.bugs.find(b => b.area === 'Nightly report')!.occurrences).toBe(MAX_SIGNALS)
  })

  it('warns and resumes when one source has more rows than the cap', async () => {
    for (let i = 0; i <= MAX_SIGNALS; i++) db.backgroundJobs.push(failedJob({ completedAt: minsAgo(30 - i / 100) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.signals).toBe(MAX_SIGNALS)
    expect(console.warn).toHaveBeenCalled()
    const mark = new Date(db.settings.get('self-diagnosis.watermark') as string)
    expect(mark.getTime()).toBeLessThan(NOW.getTime())
    expect(mark.getTime()).toBeLessThanOrEqual(minsAgo(30 - MAX_SIGNALS / 100).getTime())
    await runSelfDiagnosis(NOW)
    expect(db.bugs[0].occurrences).toBe(MAX_SIGNALS + 1)
  })

  it('does not count rows twice when a group of more than MAX_EVIDENCE signals is re-read', async () => {
    for (let i = 0; i < 12; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(20 - i) }))
    await runSelfDiagnosis(NOW)
    db.settings.set('self-diagnosis.watermark', minsAgo(30).toISOString())
    await runSelfDiagnosis(NOW)
    expect(db.bugs[0].occurrences).toBe(12)
  })

  it('counts a late-committing row stamped inside the overlap before the last seen time', async () => {
    db.jobRuns.push(failedRun({ finishedAt: minsAgo(1) }))
    await runSelfDiagnosis(NOW)
    const lastSeen = db.bugs[0].lastSeenAt as Date
    db.jobRuns.push(failedRun({ finishedAt: new Date(lastSeen.getTime() - 30_000) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.updated).toBe(1)
    expect(db.bugs[0].occurrences).toBe(2)
  })

  it('warns when the stored watermark is older than 24 h', async () => {
    db.settings.set('self-diagnosis.watermark', minsAgo(48 * 60).toISOString())
    await runSelfDiagnosis(NOW)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('older than 24 h'))
  })

  it('does not re-count an archived failed job (updatedAt bumped, completedAt old)', async () => {
    db.backgroundJobs.push(failedJob({ completedAt: minsAgo(60), updatedAt: minsAgo(60) }))
    await runSelfDiagnosis(NOW)
    db.bugs[0].status = 'resolved'
    db.backgroundJobs[0].updatedAt = minsAgo(1)
    await runSelfDiagnosis(NOW)
    expect(db.bugs[0]).toMatchObject({ occurrences: 1, status: 'resolved' })
  })

  it('does not raise severity on a triaged or in_progress bug', async () => {
    db.jobRuns.push(failedRun())
    await runSelfDiagnosis(NOW)
    db.bugs[0].status = 'triaged'
    for (let i = 0; i < 5; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(1.5 - i / 10) }))
    await runSelfDiagnosis(NOW)
    expect(db.bugs[0]).toMatchObject({ occurrences: 6, severity: 'low', status: 'triaged' })
  })
})

describe('failures', () => {
  it('retries a group whose create failed and holds the watermark', async () => {
    db.jobRuns.push(failedRun())
    db.createHook = () => { db.createHook = null; throw new Error('boom') }
    const r = await runSelfDiagnosis(NOW)
    expect(r).toMatchObject({ created: 0, skipped: 1 })
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThanOrEqual(minsAgo(5).getTime())
    await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(1)
  })

  it('recovers when a concurrent run created the same fingerprint (P2002)', async () => {
    db.jobRuns.push(failedRun())
    db.createHook = data => {
      db.createHook = null
      db.bugs.push({ id: 'other', ...data, occurrences: 0, evidence: [], lastSeenAt: null })
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    }
    await runSelfDiagnosis(NOW)
    await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(1)
    expect(db.bugs[0].occurrences).toBe(1)
  })

  it('gives up on a group that fails every run once its signals are past the lookback', async () => {
    db.jobRuns.push(failedRun())
    db.createHook = () => { throw new Error('boom') }
    await runSelfDiagnosis(NOW)
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThanOrEqual(minsAgo(5).getTime())
    const later = new Date(NOW.getTime() + 25 * 3_600_000)
    const r = await runSelfDiagnosis(later)
    expect(r.signals).toBe(0)
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBe(later.getTime() - 2 * 60_000)
  })

  it('still records other sources when one source throws, and re-reads the failed one later', async () => {
    db.jobRuns.push(failedRun())
    db.sourceHealth.push({ id: 's1', source: 'host-agent', environmentId: null, lastSeenAt: minsAgo(60), staleAfterMs: 60_000 })
    db.failSources = true // environmentSourceHealth (stale source) and the windowed queries throw
    const r = await runSelfDiagnosis(NOW)
    expect(r.created).toBe(0)
    expect(console.error).toHaveBeenCalled()
    db.failSources = false
    await runSelfDiagnosis(NOW)
    expect(db.bugs.map(b => b.area).sort()).toEqual(['Nightly report', 'host-agent'])
  })

  it('keeps the other sources when only the stale-source query throws', async () => {
    db.jobRuns.push(failedRun())
    db.envSourceHealth.push({ id: 'e1', source: 'falco', environmentId: 'env1', lastSeenAt: minsAgo(60), staleAfterMs: 300_000 })
    const orig = db.envSourceHealth
    Object.defineProperty(db, 'envSourceHealth', { get: () => { throw new Error('env down') }, configurable: true })
    const r = await runSelfDiagnosis(NOW)
    Object.defineProperty(db, 'envSourceHealth', { value: orig, writable: true, configurable: true })
    expect(r.created).toBe(1)
    expect(db.bugs[0].area).toBe('Nightly report')
  })
})

describe('severityFor', () => {
  it('follows the documented rule', () => {
    expect(severityFor(true, 1)).toBe('high')
    expect(severityFor(false, 3)).toBe('medium')
    expect(severityFor(false, 2)).toBe('low')
  })
})
