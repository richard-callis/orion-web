import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  oIDCProvider: { findFirst: vi.fn() },
}))
vi.mock('./db', () => ({ prisma: db }))

import {
  getAuthentikConfig, authentikProviders, isAuthentikEnabled, mapGroupsToRole, resolveAuthentikUser,
} from './authentik-oidc'

const row = (o: Record<string, unknown> = {}) => ({
  id: 'u1', username: 'alice', email: 'alice@example.com', name: null, role: 'user',
  provider: 'local', externalId: null, active: true, ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  db.user.findFirst.mockResolvedValue(null)
  db.user.findUnique.mockResolvedValue(null)
  db.user.update.mockImplementation(async ({ where, data }) => row({ id: where.id, ...data }))
  db.user.create.mockImplementation(async ({ data }) => row({ id: 'new', ...data }))
})

describe('provider config', () => {
  const full = { AUTHENTIK_OIDC_ISSUER: 'https://sso.example.com/application/o/orion/', AUTHENTIK_OIDC_CLIENT_ID: 'cid', AUTHENTIK_OIDC_CLIENT_SECRET: 's3cret' }

  it('is off when any of the three env values is missing or blank', () => {
    expect(authentikProviders({})).toEqual([])
    for (const k of Object.keys(full)) expect(getAuthentikConfig({ ...full, [k]: ' ' })).toBeNull()
    expect(authentikProviders({ ...full, AUTHENTIK_OIDC_CLIENT_SECRET: '' })).toEqual([])
  })

  it('builds an authentik provider with PKCE/state/nonce and discovery URL', () => {
    const [p] = authentikProviders(full)
    expect(p).toMatchObject({
      id: 'authentik', idToken: true, checks: ['pkce', 'state', 'nonce'],
      wellKnown: 'https://sso.example.com/application/o/orion/.well-known/openid-configuration',
    })
    expect(p.authorization).toMatchObject({ params: { scope: 'openid email profile groups' } })
  })

  it('isAuthentikEnabled is false unconfigured, and honours OIDCProvider.enabled', async () => {
    await expect(isAuthentikEnabled()).resolves.toBe(false)
    Object.assign(process.env, full)
    try {
      db.oIDCProvider.findFirst.mockResolvedValue(null)
      await expect(isAuthentikEnabled()).resolves.toBe(true)
      db.oIDCProvider.findFirst.mockResolvedValue({ enabled: false })
      await expect(isAuthentikEnabled()).resolves.toBe(false)
    } finally {
      for (const k of Object.keys(full)) delete process.env[k]
    }
  })
})

describe('mapGroupsToRole', () => {
  it('defaults: authentik Admins → admin, everyone else → user', () => {
    expect(mapGroupsToRole(['authentik Admins'], null)).toBe('admin')
    expect(mapGroupsToRole(['staff'], null)).toBe('user')
    expect(mapGroupsToRole(undefined, null)).toBe('user')
  })
  it('uses a custom mapping, highest role wins, ignores invalid roles and prototype keys', () => {
    const m = { ops: 'user', viewers: 'readonly', root: 'admin', bad: 'superuser' }
    expect(mapGroupsToRole(['viewers', 'ops'], m)).toBe('user')
    expect(mapGroupsToRole(['viewers', 'root'], m)).toBe('admin')
    expect(mapGroupsToRole(['bad', 'toString', '__proto__'], m)).toBe('user')
    expect(mapGroupsToRole(['authentik Admins'], m)).toBe('user') // custom mapping replaces the default
  })
})

describe('resolveAuthentikUser', () => {
  it('matches an existing link by sub, ignoring a changed username/email, and re-evaluates the role', async () => {
    db.user.findFirst.mockResolvedValueOnce(row({ provider: 'authentik', externalId: 'sub-1', role: 'admin' }))
    const r = await resolveAuthentikUser(
      { sub: 'sub-1', email: 'someone-else@example.com', email_verified: true, preferred_username: 'admin', groups: [] }, null)
    expect(db.user.findFirst).toHaveBeenCalledTimes(1)
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { provider: 'authentik', externalId: 'sub-1' } })
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ externalId: 'sub-1', role: 'user' }) // demoted
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('email')
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('username')
    expect(r).toMatchObject({ ok: true, user: { id: 'u1', username: 'alice', role: 'user' } })
  })

  it('links a local user by verified email on first login and keeps the password', async () => {
    db.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ passwordHash: 'x' }))
    const r = await resolveAuthentikUser({ sub: 'sub-2', email: 'Alice@Example.com', email_verified: true, groups: ['authentik Admins'] }, null)
    expect(db.user.findFirst.mock.calls[1][0].where.email).toEqual({ equals: 'alice@example.com', mode: 'insensitive' })
    const data = db.user.update.mock.calls[0][0].data
    expect(data).toMatchObject({ provider: 'authentik', externalId: 'sub-2', role: 'admin' })
    expect(data).not.toHaveProperty('passwordHash')
    expect(r).toMatchObject({ ok: true, user: { id: 'u1', role: 'admin' } })
  })

  it.each([false, undefined])('does not link by email when email_verified is %s; creates a new user with a placeholder email', async (verified) => {
    const r = await resolveAuthentikUser({ sub: 'sub-3', email: 'alice@example.com', email_verified: verified, preferred_username: 'alice' }, null)
    expect(db.user.findFirst).toHaveBeenCalledTimes(1) // only the sub lookup
    expect(db.user.update).not.toHaveBeenCalled()
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ provider: 'authentik', externalId: 'sub-3', email: 'sub-3@oidc.invalid', role: 'user' })
    expect(r.ok).toBe(true)
  })

  it('refuses to re-bind a user already linked to a different external identity', async () => {
    db.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ provider: 'authentik', externalId: 'other-sub' }))
    await expect(resolveAuthentikUser({ sub: 'sub-4', email: 'alice@example.com', email_verified: true }, null))
      .resolves.toEqual({ ok: false, reason: 'account_conflict' })
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it('never takes over an existing username: a new user gets a suffixed one', async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: 'taken' }).mockResolvedValueOnce(null)
    await resolveAuthentikUser({ sub: 'sub-5', email: 'new@example.com', email_verified: true, preferred_username: 'admin' }, null)
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ username: 'admin-2', email: 'new@example.com' })
  })

  it('rejects inactive users and claims without a sub', async () => {
    db.user.findFirst.mockResolvedValueOnce(row({ provider: 'authentik', externalId: 'sub-6', active: false }))
    await expect(resolveAuthentikUser({ sub: 'sub-6' }, null)).resolves.toEqual({ ok: false, reason: 'inactive' })
    await expect(resolveAuthentikUser({ sub: '' }, null)).resolves.toEqual({ ok: false, reason: 'no_sub' })
  })
})
