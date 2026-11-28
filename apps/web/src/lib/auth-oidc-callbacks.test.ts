import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  oIDCProvider: { findFirst: vi.fn() },
}))
const audit = vi.hoisted(() => ({ logAudit: vi.fn() }))
vi.mock('./db', () => ({ prisma: db }))
vi.mock('./audit', () => audit)
vi.mock('./encryption', () => ({ decrypt: vi.fn(), decryptStrict: vi.fn() }))
vi.mock('./totp', () => ({ verifyTOTP: vi.fn(), verifyRecoveryCode: vi.fn(), consumeRecoveryCode: vi.fn() }))
vi.mock('./security/notification-service', () => ({ sendNotification: vi.fn() }))

import { authOptions } from './auth'

const env = { AUTHENTIK_OIDC_ISSUER: 'https://sso.example.com/application/o/orion/', AUTHENTIK_OIDC_CLIENT_ID: 'cid', AUTHENTIK_OIDC_CLIENT_SECRET: 's3cret' }
const signIn = authOptions.callbacks!.signIn!
const jwt = authOptions.callbacks!.jwt!
const account = { provider: 'authentik', type: 'oauth', providerAccountId: 'sub-1' } as never
const dbUser = (o: Record<string, unknown> = {}) => ({
  id: 'u1', username: 'alice', email: 'alice@example.com', name: null, role: 'user',
  provider: 'authentik', externalId: 'sub-1', active: true, ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(process.env, env)
  db.oIDCProvider.findFirst.mockResolvedValue(null)
  db.user.findFirst.mockResolvedValue(dbUser())
  db.user.update.mockImplementation(async ({ data }) => dbUser(data))
})
afterEach(() => { for (const k of Object.keys(env)) delete process.env[k] })

describe('signIn callback (authentik)', () => {
  it('ignores other providers', async () => {
    await expect(signIn({ user: {}, account: { provider: 'credentials' } } as never)).resolves.toBe(true)
  })

  it('redirects with AuthentikDisabled when OIDCProvider.enabled is false', async () => {
    db.oIDCProvider.findFirst.mockResolvedValue({ enabled: false })
    await expect(signIn({ user: {}, account, profile: { sub: 'sub-1' } } as never)).resolves.toBe('/login?error=AuthentikDisabled')
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it('swaps the OIDC identity for the Orion user and audits a role change', async () => {
    db.user.findFirst.mockResolvedValue(dbUser({ role: 'admin' }))
    const user = { id: 'sub-1', username: 'sub-1', role: 'user' }
    await expect(signIn({ user, account, profile: { sub: 'sub-1', groups: [] } } as never)).resolves.toBe(true)
    expect(user).toMatchObject({ id: 'u1', username: 'alice', role: 'user' })
    const actions = audit.logAudit.mock.calls.map(c => c[0])
    expect(actions.map(a => a.action)).toEqual(['user_update', 'user_login'])
    expect(actions[0].detail).toMatchObject({ role: { from: 'admin', to: 'user' } })
  })

  it('audits user_create for an auto-provisioned user', async () => {
    db.user.findFirst.mockResolvedValue(null)
    db.user.findUnique.mockResolvedValue(null)
    db.user.create.mockImplementation(async ({ data }) => dbUser({ id: 'new', ...data }))
    await expect(signIn({ user: {}, account, profile: { sub: 'sub-9', preferred_username: 'bob' } } as never)).resolves.toBe(true)
    expect(audit.logAudit.mock.calls.map(c => c[0].action)).toEqual(['user_create', 'user_login'])
  })

  it('denies and audits (with the sub) when resolution fails or throws', async () => {
    db.user.findFirst.mockResolvedValue(dbUser({ active: false }))
    await expect(signIn({ user: {}, account, profile: { sub: 'sub-1' } } as never)).resolves.toBe(false)
    expect(audit.logAudit.mock.calls[0][0]).toMatchObject({ action: 'user_login_failure', detail: { reason: 'inactive', sub: 'sub-1' } })
    db.user.findFirst.mockRejectedValue(new Error('db down'))
    await expect(signIn({ user: {}, account, profile: { sub: 'sub-1' } } as never)).resolves.toBe(false)
    expect(audit.logAudit.mock.calls[1][0]).toMatchObject({ detail: { reason: 'error' } })
  })
})

describe('jwt callback (OIDC skips local TOTP)', () => {
  it('fresh authentik login sets oidc and mfaVerified; totpEnabled stays false', async () => {
    const t = await jwt({ token: {}, user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: true }, account } as never)
    expect(t).toMatchObject({ sub: 'u1', oidc: true, mfaVerified: true })
  })

  it('refresh forces totpEnabled=false for OIDC sessions but not for local ones', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u1', active: true, role: 'user', totpEnabled: true })
    expect((await jwt({ token: { sub: 'u1', oidc: true } } as never)).totpEnabled).toBe(false)
    expect((await jwt({ token: { sub: 'u1' } } as never)).totpEnabled).toBe(true)
  })

  it('a credentials login is not marked oidc', async () => {
    const t = await jwt({ token: {}, user: { id: 'u1', username: 'a', role: 'user' }, account: { provider: 'credentials' } } as never)
    expect(t.oidc).toBe(false)
    expect(t.mfaVerified).toBe(false)
  })
})
