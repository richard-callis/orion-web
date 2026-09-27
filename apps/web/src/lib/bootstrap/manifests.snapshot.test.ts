/**
 * Byte-for-byte snapshots of the Kubernetes manifests ORION generates during
 * cluster bootstrap. Written before the cluster-bootstrap split so the
 * refactor can prove the generated YAML is unchanged.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

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

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBcert\nline2\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIBkey\n-----END PRIVATE KEY-----'

describe('gatewayManifest', () => {
  it('unpinned image (latest, /health readiness)', () => {
    vi.stubEnv('ORION_GATEWAY_IMAGE_TAG', '')
    vi.stubEnv('GATEWAY_READINESS_PATH', '')
    expect(t.gatewayManifest('Prod Cluster_1', 'orion_join_abc')).toMatchSnapshot()
  })

  it('pinned image (/readyz readiness)', () => {
    vi.stubEnv('ORION_GATEWAY_IMAGE_TAG', 'v1.2.3')
    vi.stubEnv('GATEWAY_READINESS_PATH', '')
    expect(t.gatewayManifest('lab', 'orion_join_def')).toMatchSnapshot()
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
