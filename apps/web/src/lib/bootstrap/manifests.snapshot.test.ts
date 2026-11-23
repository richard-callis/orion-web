/**
 * Byte-for-byte snapshots of the Kubernetes manifests ORION generates during
 * cluster bootstrap. Written before the cluster-bootstrap split so the
 * refactor can prove the generated YAML is unchanged.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { gatewayReadRbac } from '../gateway-rbac'
import { GATEWAY_METRICS_RBAC } from '../metrics-server'

type Templates = typeof import('../cluster-bootstrap')
let t: Pick<Templates, 'gatewayManifest' | 'esoVaultManifest'>

beforeAll(async () => {
  // ORION_URL is resolved at module load — pin it before importing.
  vi.stubEnv('ORION_CALLBACK_URL', 'http://10.0.0.5:3000/')
  vi.stubEnv('MANAGEMENT_IP', '10.0.0.5')
  vi.resetModules()
  t = await import('../cluster-bootstrap')
})
afterAll(() => vi.unstubAllEnvs())

interface K8sObject {
  kind: string
  metadata: { name: string }
  rules?: Array<{ apiGroups: string[]; resources?: string[]; resourceNames?: string[]; verbs: string[] }>
  subjects?: unknown[]
}
const objects = (yaml: string) => parseAllDocuments(yaml).map(d => (d as { toJSON(): K8sObject | null }).toJSON()).filter((o): o is K8sObject => !!o)

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBcert\nline2\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIBkey\n-----END PRIVATE KEY-----'

describe('gatewayManifest', () => {
  it('unpinned image (latest, /health readiness)', () => {
    vi.stubEnv('ORION_GATEWAY_IMAGE_TAG', '')
    vi.stubEnv('GATEWAY_READINESS_PATH', '')
    expect(t.gatewayManifest('Prod Cluster_1', 'orion_join_abc', '')).toMatchSnapshot()
  })

  it('pinned image (/readyz readiness)', () => {
    vi.stubEnv('ORION_GATEWAY_IMAGE_TAG', 'v1.2.3')
    vi.stubEnv('GATEWAY_READINESS_PATH', '')
    expect(t.gatewayManifest('lab', 'orion_join_def', 'https://gw.example.com')).toMatchSnapshot()
  })
})

describe('gatewayManifest permissions', () => {
  const manifest = () => t.gatewayManifest('lab', 'orion_join_ghi', '')

  it('is read-only: no cluster-admin, no write verb but its own Secret', () => {
    expect(manifest()).not.toContain('cluster-admin')
    expect(manifest()).toMatch(/name: GATEWAY_READ_ONLY\n\s+value: "true"/)
    const rules = objects(manifest()).filter(o => /Role$/.test(o.kind)).flatMap(o => (o.rules ?? []).map(r => ({ role: `${o.kind}/${o.metadata.name}`, ...r })))
    expect(rules.length).toBeGreaterThan(5)
    const writes = rules.filter(r => r.verbs.some(v => !['get', 'list', 'watch'].includes(v)))
    expect(writes).toEqual([{ role: 'Role/orion-gateway-credentials', apiGroups: [''], resources: ['secrets'], resourceNames: ['orion-gateway-credentials'], verbs: ['get', 'patch'] }])
    expect(rules.filter(r => (r.resources ?? []).some(x => x === '*' || /secrets|pods\/exec/.test(x)))).toEqual(writes)
  })

  it('binds only its own ServiceAccount, under names the join manifest does not use', () => {
    const named = (yaml: string) => objects(yaml).filter(o => o.kind.startsWith('ClusterRole')).map(o => `${o.kind}/${o.metadata.name}`)
    const join = named(`${gatewayReadRbac({ name: 'orion-gateway', namespace: 'management' })}---\n${GATEWAY_METRICS_RBAC}`)
    expect(join).toHaveLength(5)
    expect(named(manifest()).filter(n => join.includes(n))).toEqual([])
    for (const o of objects(manifest()).filter(o => /Binding$/.test(o.kind))) {
      expect(o.subjects).toEqual([{ kind: 'ServiceAccount', name: 'orion-gateway', namespace: 'orion-management' }])
    }
  })

  it('pins the RBAC the join manifest ships', () => {
    expect(gatewayReadRbac({ name: 'orion-gateway', namespace: 'management' })).toMatchSnapshot()
  })
})

describe('esoVaultManifest', () => {
  it('plain http, no TLS', () => {
    expect(t.esoVaultManifest('role-1', 'secret-1', 'http://10.0.0.5:8200')).toMatchSnapshot()
  })

  it('one-way TLS (CA bundle only)', () => {
    expect(t.esoVaultManifest('role-2', 'secret-2', 'https://10.0.0.5:8200', {
      caBundleB64: 'Q0FCVU5ETEU=', clientCertPem: '', clientKeyPem: '',
    })).toMatchSnapshot()
  })

  it('mTLS (client cert + key)', () => {
    expect(t.esoVaultManifest('role-3', 'secret-3', 'https://10.0.0.5:8200', {
      caBundleB64: 'Q0FCVU5ETEU=', clientCertPem: CERT, clientKeyPem: KEY,
    })).toMatchSnapshot()
  })
})
