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

  it('gives the gateway read-only RBAC: no writes, no Secrets, no pods/exec', async () => {
    const objs = await render('?type=cluster')
    const roles = objs.filter((o: { kind: string }) => o.kind === 'ClusterRole' && o.metadata.name.startsWith('orion-gateway'))
    expect(roles.length).toBeGreaterThan(0)
    for (const r of roles) {
      for (const rule of r.rules) {
        expect(rule.verbs.every((v: string) => ['get', 'list', 'watch'].includes(v))).toBe(true)
        expect(rule.resources).not.toContain('secrets')
        expect(rule.resources).not.toContain('pods/exec')
        expect(rule.resources).not.toContain('*')
      }
    }
  })

  it("doesn't blank the gateway's saved credentials when re-applied", async () => {
    const secret = (await render('?type=cluster')).find((o: { kind: string }) => o.kind === 'Secret')
    expect(Object.keys(secret.stringData)).not.toContain('environment-id')
    expect(Object.keys(secret.stringData)).not.toContain('gateway-token')
  })
})
