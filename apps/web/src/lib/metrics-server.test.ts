import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseAllDocuments } from 'yaml'

const executeTool = vi.fn()
const localTool = vi.fn()
vi.mock('./agent-runner/gateway-client', () => ({
  GatewayClient: class { executeTool = executeTool },
}))
vi.mock('./local-exec', () => ({ makeLocalGx: () => localTool }))

import { ensureMetricsServer, metricsServerManifest, GATEWAY_METRICS_RBAC } from './metrics-server'

const docs = (yaml: string) => parseAllDocuments(yaml).map(d => {
  expect(d.errors).toEqual([])
  return d.toJS()
})

const env = { type: 'cluster', gatewayUrl: 'http://gw', gatewayToken: 't', kubeconfig: null, metadata: null }
const notFound = new Error('Error from server (NotFound): apiservices.apiregistration.k8s.io "v1beta1.metrics.k8s.io" not found')
const applied = () => executeTool.mock.calls.filter(c => c[0] === 'kubectl_apply_manifest').map(c => c[1].manifest as string)

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

  it('gateway RBAC holds every permission the metrics-server roles grant (no RBAC escalation)', () => {
    const rules = docs(GATEWAY_METRICS_RBAC).find(o => o.kind === 'ClusterRole').rules
    const has = (group: string, res: string, verb: string) =>
      rules.some((r: { apiGroups: string[]; resources: string[]; verbs: string[] }) =>
        r.apiGroups.includes(group) && r.resources.includes(res) && r.verbs.includes(verb))
    expect(has('', 'nodes/metrics', 'get')).toBe(true)
    expect(has('metrics.k8s.io', 'nodes', 'watch')).toBe(true)
    expect(has('authentication.k8s.io', 'tokenreviews', 'create')).toBe(true)
    expect(has('authorization.k8s.io', 'subjectaccessreviews', 'create')).toBe(true)
    expect(has('apiregistration.k8s.io', 'apiservices', 'create')).toBe(true)
  })
})

describe('ensureMetricsServer', () => {
  beforeEach(() => { executeTool.mockReset(); localTool.mockReset() })

  it('skips non-cluster environments', async () => {
    expect(await ensureMetricsServer({ ...env, type: 'docker' })).toMatchObject({ status: 'skipped' })
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('installs when no metrics-server exists, with insecure TLS by default', async () => {
    executeTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw notFound; return 'ok' })
    expect(await ensureMetricsServer(env)).toEqual({ status: 'installed', via: 'gateway' })
    expect(applied()).toHaveLength(2)
    expect(applied()[1]).toContain('--kubelet-insecure-tls')
  })

  it('honours metadata.metricsServer.kubeletInsecureTls = false', async () => {
    executeTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw notFound; return 'ok' })
    await ensureMetricsServer({ ...env, metadata: { metricsServer: { kubeletInsecureTls: false } } })
    expect(applied()[1]).not.toContain('--kubelet-insecure-tls')
  })

  it('leaves a metrics-server ORION does not manage alone', async () => {
    executeTool.mockImplementation(async (tool: string) =>
      tool === 'kubectl_get' ? JSON.stringify({ metadata: { labels: { 'k8s-app': 'metrics-server' } } }) : 'ok')
    expect(await ensureMetricsServer(env)).toEqual({ status: 'existing' })
    expect(applied()).toHaveLength(1) // gateway RBAC only
  })

  it('updates its own metrics-server', async () => {
    executeTool.mockImplementation(async (tool: string) =>
      tool === 'kubectl_get' ? JSON.stringify({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'orion' } } }) : 'ok')
    expect(await ensureMetricsServer(env)).toEqual({ status: 'updated', via: 'gateway' })
  })

  it('falls back to the stored kubeconfig when the gateway may not apply the RBAC', async () => {
    executeTool.mockImplementation(async (tool: string) => {
      if (tool === 'kubectl_get') throw notFound
      throw new Error('clusterroles.rbac.authorization.k8s.io "orion-gateway-metrics" is forbidden: attempting to grant RBAC permissions not currently held')
    })
    localTool.mockResolvedValue('ok')
    expect(await ensureMetricsServer({ ...env, kubeconfig: 'a2M=' })).toEqual({ status: 'installed', via: 'kubeconfig' })
    expect(localTool).toHaveBeenCalledTimes(2)
  })

  it('explains the one-time RBAC step when there is no kubeconfig to fall back to', async () => {
    executeTool.mockRejectedValue(new Error('forbidden'))
    const res = await ensureMetricsServer(env)
    expect(res.status).toBe('error')
    expect(res.status === 'error' && res.error).toMatch(/orion-gateway-metrics/)
  })

  it('reports a failed existence check that is not NotFound', async () => {
    executeTool.mockImplementation(async (tool: string) => { if (tool === 'kubectl_get') throw new Error('connection refused'); return 'ok' })
    expect(await ensureMetricsServer(env)).toMatchObject({ status: 'error' })
  })
})
