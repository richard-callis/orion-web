/** security-stale-check only scans health rows, so unconfigured DCO sources (no row) never alert. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ created: [] as any[], stale: [] as any[] }))

vi.mock('@/lib/db', () => ({
  prisma: {
    sourceHealth: { findMany: vi.fn(async () => h.stale) },
    environmentSourceHealth: { findMany: vi.fn(async () => []) },
    securityEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => { h.created.push(a.data) }),
    },
  },
}))
vi.mock('@/lib/job-runner', () => ({ startJob: vi.fn(), startJobOnce: vi.fn(), periodKey: vi.fn() }))

import { runSecurityStaleCheckJob } from './security-stale-check'
import { DCO_ENV_SOURCES, DCO_GLOBAL_SOURCES } from '@/lib/security/dco-sources'

describe('security-stale-check and the DCO catalog', () => {
  beforeEach(() => { h.created = []; h.stale = [] })

  it('emits nothing for catalog sources that have no row', async () => {
    h.stale = [{ source: 'crowdsec', lastSeenAt: new Date(), staleAfterMs: 300_000 }]
    await runSecurityStaleCheckJob(async () => {})
    expect(h.created.every(e => !(e.source in DCO_GLOBAL_SOURCES) && !(e.source in DCO_ENV_SOURCES))).toBe(true)
    expect(h.created).toEqual([])
  })

  it('still emits source_stale for a configured DCO source that went dark', async () => {
    h.stale = [{ source: 'unifi', lastSeenAt: new Date(Date.now() - 3_600_000), staleAfterMs: DCO_GLOBAL_SOURCES.unifi }]
    await runSecurityStaleCheckJob(async () => {})
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ type: 'source_stale', source: 'unifi' })
  })
})
