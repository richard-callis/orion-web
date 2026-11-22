/** Revoking an environment's git credential must be followed by re-registering it with ArgoCD. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ calls: [] as string[], tx: vi.fn(), token: vi.fn(), env: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: {
  environmentJoinToken: { findUnique: m.token, updateMany: vi.fn() },
  environment: { findUnique: m.env, update: vi.fn() },
  $transaction: m.tx,
} }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(), getClientIp: vi.fn(), getUserAgent: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => ({ id: 'admin' })) }))
vi.mock('@/lib/ssrf-guard', () => ({ isPrivateUrl: vi.fn(async () => false) }))
vi.mock('@/lib/environment-git-credentials', () => ({ revokeEnvironmentGitCredential: vi.fn(async (id: string) => { m.calls.push(`revoke ${id}`) }) }))
vi.mock('@/lib/bootstrap/argocd-install', () => ({ refreshArgoCDRepo: vi.fn(async (id: string) => { m.calls.push(`refresh ${id}`) }) }))

import { POST as join } from './join/route'
import { POST as rotate } from './[id]/rotate-token/route'

const env = { id: 'env-1', name: 'lab', type: 'cluster', gatewayUrl: null, gatewayToken: 'old' }
const post = (body: object) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never

beforeEach(() => {
  m.calls.length = 0
  m.env.mockReset().mockResolvedValue(env)
  m.tx.mockReset().mockResolvedValue([{ count: 1 }, env])
  m.token.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('git credential re-registration', () => {
  it('follows a first join', async () => {
    m.token.mockResolvedValue({ id: 't', environmentId: 'env-1', environment: env, usedAt: null, expiresAt: new Date(Date.now() + 1e6) })
    expect((await join(post({ joinToken: 'tok', machineId: 'm' }))).status).toBe(200)
    expect(m.calls).toEqual(['revoke env-1', 'refresh env-1'])
  })
  it('does not follow an idempotent re-join, which revokes nothing', async () => {
    m.token.mockResolvedValue({ id: 't', environmentId: 'env-1', environment: env, usedAt: new Date(), fingerprint: null, expiresAt: new Date(Date.now() + 1e6) })
    expect((await join(post({ joinToken: 'tok' }))).status).toBe(200)
    expect(m.calls).toEqual([])
  })
  it('follows a token rotation', async () => {
    expect((await rotate(post({}), { params: Promise.resolve({ id: 'env-1' }) })).status).toBe(200)
    expect(m.calls).toEqual(['revoke env-1', 'refresh env-1'])
  })
})
