import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { gatewayImageSpec } from './gateway-image'

describe('gatewayImageSpec', () => {
  it('unpinned: latest image, Always pull, /health for both probes', () => {
    const spec = gatewayImageSpec({ GITHUB_ORG: 'acme' } as NodeJS.ProcessEnv)
    expect(spec).toEqual({
      image: 'ghcr.io/acme/orion-gateway:latest',
      pinned: false,
      pullPolicy: 'Always',
      livenessPath: '/health',
      readinessPath: '/health',
    })
  })

  it('explicit latest is treated as unpinned', () => {
    const spec = gatewayImageSpec({ ORION_GATEWAY_IMAGE_TAG: 'latest' } as NodeJS.ProcessEnv)
    expect(spec.pinned).toBe(false)
    expect(spec.readinessPath).toBe('/health')
  })

  it('pinned: versioned image, IfNotPresent, /readyz readiness, /health liveness', () => {
    const sha = '4ef3d91c0ffee0000000000000000000000000ab'
    const spec = gatewayImageSpec({ GITHUB_ORG: 'acme', ORION_GATEWAY_IMAGE_TAG: sha } as NodeJS.ProcessEnv)
    expect(spec.image).toBe(`ghcr.io/acme/orion-gateway:${sha}`)
    expect(spec.pinned).toBe(true)
    expect(spec.pullPolicy).toBe('IfNotPresent')
    expect(spec.livenessPath).toBe('/health')
    expect(spec.readinessPath).toBe('/readyz')
  })

  it('defaults the org when GITHUB_ORG is unset', () => {
    expect(gatewayImageSpec({} as NodeJS.ProcessEnv).image).toBe('ghcr.io/richard-callis/orion-gateway:latest')
  })

  it('rejects a malformed tag instead of injecting it into YAML', () => {
    const spec = gatewayImageSpec({ ORION_GATEWAY_IMAGE_TAG: 'v1\n  evil: true' } as NodeJS.ProcessEnv)
    expect(spec.image).toBe('ghcr.io/richard-callis/orion-gateway:latest')
    expect(spec.pinned).toBe(false)
  })

  it('GATEWAY_READINESS_PATH overrides readiness (rollback to a pre-/readyz image)', () => {
    const spec = gatewayImageSpec({
      ORION_GATEWAY_IMAGE_TAG: 'abc123',
      GATEWAY_READINESS_PATH: '/health',
    } as NodeJS.ProcessEnv)
    expect(spec.readinessPath).toBe('/health')
  })

  it('ignores an unsafe readiness override', () => {
    const spec = gatewayImageSpec({
      ORION_GATEWAY_IMAGE_TAG: 'abc123',
      GATEWAY_READINESS_PATH: '/x }\n  evil',
    } as NodeJS.ProcessEnv)
    expect(spec.readinessPath).toBe('/readyz')
  })
})

// ── Join manifest renders the spec ────────────────────────────────────────────

const findUnique = vi.fn()
vi.mock('@/lib/db', () => ({
  prisma: {
    environmentJoinToken: { findUnique: (...a: unknown[]) => findUnique(...a) },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}))

describe('join manifest gateway image + probes', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    findUnique.mockReset()
    findUnique.mockResolvedValue({
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      environment: { name: 'Prod', type: 'cluster', gatewayUrl: null },
    })
  })
  afterEach(() => { process.env = { ...saved } })

  async function render(): Promise<string> {
    const { GET } = await import('@/app/api/environments/join/[token]/manifest/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest('http://orion.test/api/environments/join/tok/manifest'), {
      params: Promise.resolve({ token: 'tok' }),
    })
    expect(res.status).toBe(200)
    return res.text()
  }

  it('unpinned manifest never probes /livez or /readyz', async () => {
    delete process.env.ORION_GATEWAY_IMAGE_TAG
    const yaml = await render()
    expect(yaml).toContain('orion-gateway:latest')
    expect(yaml).toContain('imagePullPolicy: Always')
    expect(yaml).not.toMatch(/path: \/(livez|readyz)/)
    expect(yaml).toContain('path: /health')
  })

  it('pinned manifest uses the pinned image and /readyz readiness', async () => {
    process.env.ORION_GATEWAY_IMAGE_TAG = 'deadbeef'
    const yaml = await render()
    expect(yaml).toContain('orion-gateway:deadbeef')
    expect(yaml).toContain('imagePullPolicy: IfNotPresent')
    expect(yaml).toMatch(/livenessProbe:\s*\n\s*httpGet: \{ path: \/health/)
    expect(yaml).toMatch(/readinessProbe:\s*\n\s*httpGet: \{ path: \/readyz/)
  })
})
