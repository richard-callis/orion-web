/**
 * GET /api/monitoring/security/sources — DCO catalog (docs/design/dco-visibility.md §7).
 * A catalog source without a health row is `not_configured`; per-env sources are
 * reported per environment, never collapsed per name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  global: [] as any[],
  env: [] as any[],
  envs: [] as any[],
}))

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => ({})) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    sourceHealth: { findMany: vi.fn(async () => h.global) },
    environmentSourceHealth: { findMany: vi.fn(async () => h.env) },
    environment: { findMany: vi.fn(async () => h.envs) },
    securityEvent: { groupBy: vi.fn(async (): Promise<any[]> => []) },
  },
}))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { DCO_ENV_SOURCES, DCO_GLOBAL_SOURCES } from '@/lib/security/dco-sources'

const row = (source: string, environmentId: string | null, ageMs: number, staleAfterMs = 180_000) => ({
  source, environmentId, lastSeenAt: new Date(Date.now() - ageMs), lastWatermark: null, staleAfterMs,
})

async function sources(): Promise<any[]> {
  return (await (await GET()).json()).sources
}

beforeEach(() => {
  h.global = []
  h.env = []
  h.envs = [{ id: 'envA', name: 'prod' }, { id: 'envB', name: 'lab' }]
})

describe('sources route: DCO catalog', () => {
  it('returns every catalog source without a row as not_configured', async () => {
    const out = await sources()
    expect(prisma.environment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: 'cluster' } }))
    const nc = out.filter(s => s.status === 'not_configured')
    expect(nc.filter(s => s.environmentId === null).map(s => s.source).sort()).toEqual(Object.keys(DCO_GLOBAL_SOURCES).sort())
    expect(nc.filter(s => s.environmentId === 'envA').map(s => s.source).sort()).toEqual(Object.keys(DCO_ENV_SOURCES).sort())
    expect(nc.every(s => s.lastSeenAt === null && s.alertCount24h === 0)).toBe(true)
  })

  it('a global row replaces its not_configured entry', async () => {
    h.global = [row('unifi', null, 1000, 300_000)]
    const out = await sources()
    expect(out.filter(s => s.source === 'unifi')).toEqual([expect.objectContaining({ status: 'healthy' })])
  })

  it('env A stale + env B healthy shows both; an env without a row is not_configured', async () => {
    h.envs.push({ id: 'envC', name: 'dev' })
    h.env = [row('k8s_inventory', 'envA', 5 * 60_000), row('k8s_inventory', 'envB', 1000)]
    const inv = (await sources()).filter(s => s.source === 'k8s_inventory')
    const by = Object.fromEntries(inv.map(s => [s.environmentId, s]))
    expect(inv).toHaveLength(3)
    expect(by.envA).toMatchObject({ status: 'stale', environmentName: 'prod' })
    expect(by.envB).toMatchObject({ status: 'healthy', environmentName: 'lab' })
    expect(by.envC).toMatchObject({ status: 'not_configured', environmentName: 'dev' })
  })

  it('alertCount24h of a per-env DCO source is scoped to its environment', async () => {
    h.env = [row('k8s_inventory', 'envA', 5 * 60_000), row('k8s_inventory', 'envB', 1000)]
    vi.mocked(prisma.securityEvent.groupBy).mockResolvedValueOnce([
      { source: 'k8s_inventory', environmentId: 'envA', _count: { id: 3 } },
    ])
    const by = Object.fromEntries((await sources()).filter(s => s.source === 'k8s_inventory').map(s => [s.environmentId, s]))
    expect(by.envA.alertCount24h).toBe(3)
    expect(by.envB.alertCount24h).toBe(0)
  })

  it('legacy per-env sources (falco) are still collapsed per name', async () => {
    h.env = [row('falco', 'envA', 1000), row('falco', 'envB', 2000)]
    expect((await sources()).filter(s => s.source === 'falco')).toHaveLength(1)
  })
})
