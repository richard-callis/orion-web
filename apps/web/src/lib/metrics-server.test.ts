import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseAllDocuments } from 'yaml'

const executeTool = vi.fn()
const localTool = vi.fn()
const cleanup = vi.fn()
vi.mock('./agent-runner/gateway-client', () => ({
  GatewayClient: class { executeTool = executeTool },
}))
vi.mock('./local-exec', () => ({ makeLocalGx: () => Object.assign(localTool, { cleanup }) }))

import { ensureMetricsServer, metricsServerManifest, GATEWAY_METRICS_RBAC } from './metrics-server'

const docs = (yaml: string) => parseAllDocuments(yaml).map(d => {
  expect(d.errors).toEqual([])
  return d.toJS()
})

const env = { type: 'cluster', gatewayUrl: 'http://gw', gatewayToken: 't', kubeconfig: null, metadata: null }
const notFound = new Error('Error from server (NotFound): apiservices.apiregistration.k8s.io "v1beta1.metrics.k8s.io" not found')
const gatewayApplies = () => executeTool.mock.calls.filter(c => c[0] === 'kubectl_apply_manifest')
const adminApplied = () => localTool.mock.calls.filter(c => c[0] === 'kubectl_apply_manifest').map(c => c[1].manifest as string)
const withKubeconfig = { ...env, kubeconfig: 'a2M=' }

describe('metrics-server manifests', () => {
  it('are valid YAML, labelled ORION-managed', () => {
    const objs = docs(metricsServerManifest({ kubeletInsecureTls: true }))
    expect(objs.map(o => o.kind)).toEqual([
      'ServiceAccount', 'ClusterRole', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding',
      'ClusterRoleBinding', 'Service', 'Deployment', 'APIService',
    ])
    for (const o of objs) expect(o.metadata.labels['app.kubernetes.io/managed-by']).toBe('orion')
  })

  it('toggles --kubelet-insecure-tls', () => {
    const args = (insecure: boolean) => docs(metricsServerManifest({ kubeletInsecureTls: insecure }))
      .find(o => o.kind === 'Deployment').spec.template.spec.containers[0].args as string[]
    expect(args(true)).toContain('--kubelet-insecure-tls')
    expect(args(false)).not.toContain('--kubelet-insecure-tls')
  })

  it('gateway RBAC is read-only (no write verbs, no RBAC-granting rights)', () => {
    const rules = docs(GATEWAY_METRICS_RBAC).find(o => o.kind === 'ClusterRole').rules
    const verbs = rules.flatMap((r: { verbs: string[] }) => r.verbs)
    expect(verbs.every((v: string) => ['get', 'list', 'watch'].includes(v))).toBe(true)
    const has = (group: string, res: string) =>
      rules.some((r: { apiGroups: string[]; resources: string[] }) => r.apiGroups.includes(group) && r.resources.includes(res))
    expect(has('metrics.k8s.io', 'nodes')).toBe(true)
    expect(has('', 'nodes/metrics')).toBe(true)
    expect(has('', 'serviceaccounts')).toBe(false)
  })
})

describe('ensureMetricsServer', () => {
  beforeEach(() => { executeTool.mockReset(); localTool.mockReset() })

  it('needs no gateway with a stored kubeconfig, and cleans it up', async () => {
    cleanup.mockReset()
    localTool.mockRejectedValueOnce(notFound).mockResolvedValue('')
    expect(await ensureMetricsServer({ ...withKubeconfig, gatewayUrl: null, gatewayToken: null })).toEqual({ status: 'installed', via: 'kubeconfig' })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(await ensureMetricsServer({ ...env, gatewayUrl: null })).toMatchObject({ status: 'skipped' })
  })

  it('skips non-cluster environments', async () => {
    expect(await ensureMetricsServer({ ...env, type: 'docker' })).toMatchObject({ status: 'skipped' })
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('installs with the stored admin kubeconfig, never through the gateway, with insecure TLS by default', async () => {
    localTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw notFound; return 'ok' })
    expect(await ensureMetricsServer(withKubeconfig)).toEqual({ status: 'installed', via: 'kubeconfig' })
    expect(executeTool).not.toHaveBeenCalled()
    expect(adminApplied()).toHaveLength(1)
    expect(adminApplied()[0]).toContain('orion-gateway-metrics')
    expect(adminApplied()[0]).toContain('--kubelet-insecure-tls')
  })

  it('honours metadata.metricsServer.kubeletInsecureTls = false', async () => {
    localTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw notFound; return 'ok' })
    await ensureMetricsServer({ ...withKubeconfig, metadata: { metricsServer: { kubeletInsecureTls: false } } })
    expect(adminApplied()[0]).not.toContain('--kubelet-insecure-tls')
  })

  it('leaves a metrics-server ORION does not manage alone', async () => {
    localTool.mockImplementation(async (tool: string) =>
      tool === 'kubectl_get' ? JSON.stringify({ metadata: { labels: { 'k8s-app': 'metrics-server' } } }) : 'ok')
    expect(await ensureMetricsServer(withKubeconfig)).toEqual({ status: 'existing' })
    expect(gatewayApplies()).toHaveLength(0)
    expect(adminApplied()).toHaveLength(0)
  })

  it('updates its own metrics-server with admin credentials', async () => {
    localTool.mockImplementation(async (tool: string) =>
      tool === 'kubectl_get' ? JSON.stringify({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'orion' } } }) : 'ok')
    expect(await ensureMetricsServer(withKubeconfig)).toEqual({ status: 'updated', via: 'kubeconfig' })
  })

  it('explains the admin step when no kubeconfig is stored, without writing through the gateway', async () => {
    executeTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw notFound; return 'ok' })
    const res = await ensureMetricsServer(env)
    expect(res.status).toBe('error')
    expect(res.status === 'error' && res.error).toMatch(/only=metrics-server/)
    expect(gatewayApplies()).toHaveLength(0)
  })

  it('explains the admin step when the gateway may not read the APIService', async () => {
    executeTool.mockRejectedValue(new Error('apiservices.apiregistration.k8s.io "v1beta1.metrics.k8s.io" is forbidden'))
    const res = await ensureMetricsServer(env)
    expect(res.status === 'error' && res.error).toMatch(/join token.*only=metrics-server/)
  })

  it('reports a failed existence check that is not NotFound', async () => {
    executeTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw new Error('connection refused'); return 'ok' })
    expect(await ensureMetricsServer(env)).toMatchObject({ status: 'error' })
  })
})
