import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile, stat } from 'fs/promises'

const m = vi.hoisted(() => ({
  calls: [] as string[],
  runCapture: vi.fn(), runQuiet: vi.fn(), runCommand: vi.fn(), ensure: vi.fn(), register: vi.fn(),
  tokenCreate: vi.fn(), tokenDelete: vi.fn(), envUpdate: vi.fn(), isPrivate: vi.fn(),
}))
vi.mock('../db', () => ({ prisma: { environmentJoinToken: { create: m.tokenCreate, deleteMany: m.tokenDelete }, environment: { update: m.envUpdate } } }))
vi.mock('../ssrf-guard', () => ({ isPrivateUrl: m.isPrivate }))
vi.mock('./shell', () => ({ runCapture: m.runCapture, runQuiet: m.runQuiet, runCommand: m.runCommand }))
vi.mock('./argocd', () => ({ argocdLogin: vi.fn(async () => null), argocdRegisterCluster: vi.fn(), argocdConfigureApp: vi.fn(), extractKubeconfigServer: vi.fn() }))
vi.mock('./argocd-install', () => ({ ensureInClusterArgoCD: m.ensure, registerArgoCDRepo: m.register }))
vi.mock('./git-repo', () => ({ ensureGitRepo: vi.fn(async () => ({ owner: 'o', repo: 'r', url: 'u', healthy: true })) }))
vi.mock('./monitoring', () => ({ deployBootstrapMonitoring: vi.fn() }))
vi.mock('./vault-eso', () => ({ bootstrapK8sVaultAndEso: vi.fn() }))

import { bootstrapK8sCluster } from './k8s'
import type { BootstrapEnvironment } from './types'

const ENV = { id: 'env-1', name: 'lab', gatewayUrl: null, kubeconfig: Buffer.from('x').toString('base64') } as unknown as BootstrapEnvironment
const SA = { kind: 'ServiceAccount', namespace: 'orion-management', name: 'orion-gateway' }
const binding = (name: string, subjects: unknown[], role = 'cluster-admin') => ({ metadata: { name }, roleRef: { kind: 'ClusterRole', name: role }, subjects })
const OLD = binding('orion-gateway-admin', [SA])
const events: string[] = []
const emit = (e: { message: string }) => { events.push(e.message) }
let manifest = ''
let manifestMode = 0

function cluster({ gateway = '', bindings = [] as unknown[], bindingsFail = false, gatewayFail = false }) {
  m.runCapture.mockImplementation(async (_c: string, a: string[]) => {
    if (a[1] === 'deployment') return gatewayFail ? { ok: false, stdout: '', stderr: 'timeout' } : { ok: true, stdout: gateway, stderr: '' }
    if (bindingsFail) return { ok: false, stdout: '', stderr: 'Forbidden' }
    // kubectl succeeds with noise on stderr when an aggregated API is down.
    return { ok: true, stdout: JSON.stringify({ items: [binding('other', [{ kind: 'Group', name: 'system:masters' }]), binding('viewers', [SA], 'view'), ...bindings] }), stderr: 'E1122 memcache.go' }
  })
}

beforeEach(() => {
  events.length = 0
  m.calls.length = 0
  manifest = ''
  for (const f of [m.runCapture, m.runQuiet, m.runCommand, m.ensure, m.register, m.tokenCreate, m.tokenDelete, m.envUpdate, m.isPrivate]) f.mockReset()
  m.runQuiet.mockResolvedValue({ ok: true, out: '' })
  m.runCommand.mockImplementation(async (_c: string, a: string[]) => {
    m.calls.push(a.slice(0, 3).join(' ').replace(/ \/.*/, ''))
    if (a[0] === 'apply') { manifest = await readFile(a[2], 'utf8'); manifestMode = (await stat(a[2])).mode & 0o777 }
  })
  m.ensure.mockImplementation(async () => { m.calls.push('argocd'); return 'argocd' })
  m.register.mockImplementation(async () => { m.calls.push('registered') })
  m.tokenDelete.mockImplementation(async () => { m.calls.push('burn tokens') })
  m.isPrivate.mockResolvedValue(true)
})
const run = (env = ENV) => bootstrapK8sCluster(env, emit)

describe('bootstrapK8sCluster', () => {
  it('installs ArgoCD, starts the gateway from a clean slate, then registers the repo', async () => {
    cluster({})
    await run()
    expect(m.calls).toEqual(['cluster-info', 'argocd', 'delete secret orion-gateway-credentials', 'burn tokens', 'apply -f', 'registered'])
    expect(m.register.mock.calls[0].slice(0, 2)).toEqual([{ id: 'env-1', name: 'lab', gitOwner: 'o', gitRepo: 'r' }, 'argocd'])
    expect(manifestMode).toBe(0o600)
  })
  it('stores only the hash of the join token', async () => {
    cluster({})
    await run()
    const stored = m.tokenCreate.mock.calls[0][0].data.token
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest).not.toContain(stored)
  })
  it('does not register without ArgoCD', async () => {
    cluster({})
    m.ensure.mockResolvedValue(null)
    await run()
    expect(m.register).not.toHaveBeenCalled()
  })
  it('re-registers on a re-run, leaving a running gateway and its tokens alone', async () => {
    cluster({ gateway: 'deployment.apps/orion-gateway' })
    await run()
    expect(m.calls).toEqual(['cluster-info', 'argocd', 'registered'])
    expect(events.join('\n')).not.toContain('WARNING')
  })
  it('stops when it cannot tell whether the gateway is there', async () => {
    cluster({ gatewayFail: true })
    await expect(run()).rejects.toThrow('timeout')
    expect(m.calls).not.toContain('apply -f')
  })

  describe('cluster-admin', () => {
    it('removes the old binding before deploying', async () => {
      cluster({ bindings: [OLD] })
      await run()
      expect(m.calls.indexOf('delete clusterrolebinding orion-gateway-admin')).toBeGreaterThan(0)
      expect(m.calls.indexOf('delete clusterrolebinding orion-gateway-admin')).toBeLessThan(m.calls.indexOf('apply -f'))
    })
    it.each([
      ['the old name with another subject', binding('orion-gateway-admin', [SA, { kind: 'User', name: 'bob' }])],
      ['another name', binding('mine', [SA])],
      ['a group of all its ServiceAccounts', binding('mine', [{ kind: 'Group', name: 'system:serviceaccounts:orion-management' }])],
      ['the ServiceAccount as a user', binding('mine', [{ kind: 'User', name: 'system:serviceaccount:orion-management:orion-gateway' }])],
    ])('refuses to deploy under %s', async (_n, b) => {
      cluster({ bindings: [OLD, b].filter(x => x.metadata.name !== b.metadata.name || x === b) })
      await expect(run()).rejects.toThrow(/bound to cluster-admin by/)
      expect(m.calls).toEqual(['cluster-info', 'argocd'])
    })
    it('refuses to deploy when it cannot check', async () => {
      cluster({ bindingsFail: true })
      await expect(run()).rejects.toThrow('Forbidden')
      expect(m.calls).not.toContain('apply -f')
    })
    it('only warns about a running gateway, also when it cannot check', async () => {
      cluster({ gateway: 'deployment.apps/orion-gateway', bindings: [OLD] })
      await run()
      expect(events.join('\n')).toContain('still bound to cluster-admin (orion-gateway-admin). To make it read-only, delete Deployment')
      events.length = 0
      cluster({ gateway: 'deployment.apps/orion-gateway', bindings: [OLD, binding('mine', [SA])] })
      await run()
      expect(events.join('\n')).toContain('by mine. Remove it from there, then delete Deployment')
      events.length = 0
      cluster({ gateway: 'deployment.apps/orion-gateway', bindingsFail: true })
      await run()
      expect(events.join('\n')).toContain('may be bound to cluster-admin')
      expect(events.join('\n')).not.toContain('delete Deployment')
      expect(m.calls).not.toContain('delete clusterrolebinding orion-gateway-admin')
    })
  })

  describe('gateway URL', () => {
    it('is left out when the join would refuse it; ORION keeps the one it has', async () => {
      cluster({})
      await run({ ...ENV, gatewayUrl: 'http://10.0.0.9:30001' })
      expect(manifest).toMatch(/name: GATEWAY_URL\n\s+value: ""/)
      expect(events[events.length - 1]).toContain('within ~30 seconds.')
    })
    it('says so when there is none at all', async () => {
      cluster({})
      await run()
      expect(events[events.length - 1]).toContain('no URL to call it at')
    })
    it("is the environment's own, else the in-cluster Service", async () => {
      cluster({})
      m.isPrivate.mockResolvedValue(false)
      await run({ ...ENV, gatewayUrl: 'https://gw.example.com' })
      expect(manifest).toContain('value: "https://gw.example.com"')
      await run()
      expect(manifest).toContain('value: "http://orion-gateway.orion-management.svc.cluster.local:3001"')
      expect(events[events.length - 1]).toContain('within ~30 seconds')
    })
  })
})
