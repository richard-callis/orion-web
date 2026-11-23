import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, any>
const db = vi.hoisted(() => ({
  bugs: [] as Row[],
  settings: new Map<string, unknown>(),
  backgroundJobs: [] as Row[],
  jobRuns: [] as Row[],
  sourceHealth: [] as Row[],
  envSourceHealth: [] as Row[],
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findUnique: async ({ where }: any) => (db.settings.has(where.key) ? { value: db.settings.get(where.key) } : null),
      upsert: async ({ where, create }: any) => { db.settings.set(where.key, create.value) },
    },
    backgroundJob: { findMany: async ({ take }: any) => db.backgroundJobs.slice(0, take) },
    jobRun: { findMany: async ({ take }: any) => db.jobRuns.slice(0, take) },
    sourceHealth: { findMany: async () => db.sourceHealth },
    environmentSourceHealth: { findMany: async () => db.envSourceHealth },
    bug: {
      findMany: async ({ where }: any) => db.bugs.filter(b => where.fingerprint.in.includes(b.fingerprint)),
      create: async ({ data }: any) => { db.bugs.push({ id: `bug${db.bugs.length}`, createdAt: new Date(), ...data }) },
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
    ].join('\n'))
    for (const s of ['abc.def-123', 'hunter2', 'sk-live-999', 's3cr3t', 'p4ss', blob, 'zzz']) expect(out).not.toContain(s)
    expect(out).toContain('db.example.com')
  })

  it('leaves ordinary paths alone and caps excerpts at 2000 chars', () => {
    expect(redact('at /usr/lib/node_modules/some-package-with-a-long-name/dist/index.js:10')).toContain('some-package')
    const s = makeSignal({ kind: 'k', area: 'a', text: 'x', excerpt: 'y'.repeat(5000), ref: 'r', at: NOW, windowed: true })
    expect(s.excerpt).toHaveLength(2000)
  })

  it('never stores a secret in a Bug', async () => {
    db.jobRuns.push(failedRun({ errorMessage: 'login failed password=hunter2 via redis://u:pw@cache.example.com' }))
    await runSelfDiagnosis(NOW)
    expect(JSON.stringify(db.bugs)).not.toMatch(/hunter2|u:pw/)
  })
})

describe('runSelfDiagnosis', () => {
  it('creates one bug for the same fault on different rows', async () => {
    db.backgroundJobs.push(failedJob(), failedJob({ logs: ['pod web-1a2b3c4d5-x2k4q crashed'] }))
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
    db.jobRuns.push(failedRun())
    await runSelfDiagnosis(NOW)
    expect(db.settings.get('self-diagnosis.watermark')).toBe(NOW.toISOString())
    const again = await runSelfDiagnosis(new Date(NOW.getTime() + 600_000))
    expect(again).toMatchObject({ created: 0, updated: 0 }) // same row re-read: no double count
    expect(db.bugs[0].occurrences).toBe(1)
  })

  it('bumps occurrences, appends evidence within the cap and raises severity', async () => {
    db.jobRuns.push(failedRun())
    await runSelfDiagnosis(NOW)
    for (let i = 0; i < 12; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(4 - i / 10) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.updated).toBe(1)
    const bug = db.bugs[0]
    expect(bug.occurrences).toBe(13)
    expect(bug.evidence).toHaveLength(MAX_EVIDENCE)
    expect(bug.severity).toBe('medium')
  })

  it('reopens resolved and closed bugs with a regression note, keeps triaged and in_progress', async () => {
    for (const [i, status] of ['resolved', 'closed', 'triaged', 'in_progress'].entries()) {
      db.jobRuns.push(failedRun({ errorMessage: `fault kind ${'abcd'[i]}-x` }))
    }
    await runSelfDiagnosis(NOW)
    const statuses = ['resolved', 'closed', 'triaged', 'in_progress']
    db.bugs.forEach((b, i) => { b.status = statuses[i] })
    db.jobRuns.length = 0
    for (let i = 0; i < 4; i++) db.jobRuns.push(failedRun({ errorMessage: `fault kind ${'abcd'[i]}-x` }))
    await runSelfDiagnosis(NOW)
    expect(db.bugs.map(b => b.status)).toEqual(['open', 'open', 'triaged', 'in_progress'])
    expect(db.bugs[0].evidence[0].note).toBe('regressed after being resolved')
    expect(db.bugs[2].evidence.some((e: Row) => e.note)).toBe(false)
  })

  it('files stale security sources once per source and does not re-count the same outage', async () => {
    const stale = minsAgo(60)
    db.sourceHealth.push({ id: 's1', source: 'crowdsec', environmentId: null, lastSeenAt: stale, staleAfterMs: 60_000 })
    db.sourceHealth.push({ id: 's2', source: 'wazuh', environmentId: null, lastSeenAt: minsAgo(1), staleAfterMs: 600_000 })
    db.envSourceHealth.push(
      { id: 'e1', source: 'falco', environmentId: 'env1', lastSeenAt: stale, staleAfterMs: 300_000 },
      { id: 'e2', source: 'falco', environmentId: 'env2', lastSeenAt: stale, staleAfterMs: 300_000 },
    )
    await runSelfDiagnosis(NOW)
    expect(db.bugs.map(b => b.area).sort()).toEqual(['crowdsec', 'falco'])
    expect(db.bugs.every(b => b.severity === 'high')).toBe(true)
    expect(db.bugs.find(b => b.area === 'falco')!.occurrences).toBe(2)
    await runSelfDiagnosis(new Date(NOW.getTime() + 600_000))
    expect(db.bugs.find(b => b.area === 'crowdsec')!.occurrences).toBe(1)
  })

  it('caps new bugs per run and holds the watermark back so the rest follows', async () => {
    for (let i = 0; i < MAX_NEW_BUGS + 5; i++) {
      db.jobRuns.push(failedRun({ errorMessage: `distinct fault ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}x`, finishedAt: minsAgo(30 - i / 10) }))
    }
    const r = await runSelfDiagnosis(NOW)
    expect(r.created).toBe(MAX_NEW_BUGS)
    expect(r.skipped).toBe(5)
    expect(console.warn).toHaveBeenCalled()
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThan(NOW.getTime())
    const next = await runSelfDiagnosis(NOW)
    expect(db.bugs).toHaveLength(MAX_NEW_BUGS + 5)
    expect(next.skipped).toBe(0)
  })

  it('caps signals per run', async () => {
    for (let i = 0; i < MAX_SIGNALS; i++) db.jobRuns.push(failedRun({ finishedAt: minsAgo(30 - i / 100) }))
    for (let i = 0; i < 10; i++) db.backgroundJobs.push(failedJob({ completedAt: minsAgo(1) }))
    const r = await runSelfDiagnosis(NOW)
    expect(r.signals).toBe(MAX_SIGNALS)
    expect(console.warn).toHaveBeenCalled()
    expect(new Date(db.settings.get('self-diagnosis.watermark') as string).getTime()).toBeLessThan(NOW.getTime())
  })
})

describe('severityFor', () => {
  it('follows the documented rule', () => {
    expect(severityFor(true, 1)).toBe('high')
    expect(severityFor(false, 3)).toBe('medium')
    expect(severityFor(false, 2)).toBe('low')
  })
})
