import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { parseAllDocuments } from 'yaml'

vi.mock('@/lib/db', () => ({
  prisma: {
    environmentJoinToken: {
      findUnique: vi.fn(async () => ({
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        environment: { name: 'talos', type: 'cluster' },
      })),
    },
    systemSetting: { findUnique: vi.fn(async () => null) },
  },
}))

import { GET } from './route'

async function render(query: string) {
  const res = await GET(new NextRequest(`http://orion/api/environments/join/tok/manifest${query}`), { params: Promise.resolve({ token: 'tok' }) })
  return parseAllDocuments(await res.text()).map(d => {
    expect(d.errors).toEqual([])
    return d.toJS()
  }).filter(Boolean)
}

const names = (objs: { kind: string; metadata: { name: string } }[]) => objs.map(o => `${o.kind}/${o.metadata.name}`)

describe('join manifest', () => {
  it('ships metrics-server with a cluster gateway by default', async () => {
    const objs = await render('?type=cluster')
    expect(names(objs)).toEqual(expect.arrayContaining([
      'Deployment/orion-gateway-talos',
      'ClusterRole/orion-gateway-metrics',
      'Deployment/metrics-server',
      'APIService/v1beta1.metrics.k8s.io',
    ]))
  })

  it('omits metrics-server with metricsServer=0', async () => {
    const objs = await render('?type=cluster&metricsServer=0')
    expect(names(objs)).toContain('Deployment/orion-gateway-talos')
    expect(names(objs)).not.toContain('Deployment/metrics-server')
  })

  it('omits metrics-server for non-Kubernetes gateway types', async () => {
    expect(names(await render('?type=docker'))).not.toContain('Deployment/metrics-server')
  })

  it('only=metrics-server returns metrics-server + gateway RBAC and leaves the gateway alone', async () => {
    const n = names(await render('?type=cluster&only=metrics-server'))
    expect(n).toEqual(expect.arrayContaining(['ClusterRole/orion-gateway-metrics', 'Deployment/metrics-server', 'APIService/v1beta1.metrics.k8s.io']))
    expect(n.some(x => x.startsWith('Secret/') || x.startsWith('Deployment/orion-gateway'))).toBe(false)
  })
})
