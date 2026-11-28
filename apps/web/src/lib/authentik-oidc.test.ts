import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
  db.user.findMany.mockResolvedValue([])
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

  it('email linking is opt-in via AUTHENTIK_OIDC_LINK_BY_EMAIL=true', () => {
    expect(getAuthentikConfig(full)?.linkByEmail).toBe(false)
    expect(getAuthentikConfig({ ...full, AUTHENTIK_OIDC_LINK_BY_EMAIL: 'true' })?.linkByEmail).toBe(true)
    expect(getAuthentikConfig({ ...full, AUTHENTIK_OIDC_LINK_BY_EMAIL: 'yes' })?.linkByEmail).toBe(false)
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
    expect(mapGroupsToRole(['authentik Admins'], {})).toBe('admin') // empty mapping = default
    expect(mapGroupsToRole(['g'], { g: 'toString' })).toBe('user') // inherited keys are not roles
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

  it('does not link by email unless linkByEmail is enabled', async () => {
    db.user.findMany.mockResolvedValue([row()])
    const r = await resolveAuthentikUser({ sub: 'sub-2', email: 'alice@example.com', email_verified: true }, null)
    expect(db.user.findMany).not.toHaveBeenCalled()
    expect(db.user.update).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, created: true, linked: false })
  })

  it('links a local user by verified email on first login (opt-in) and keeps the password', async () => {
    db.user.findMany.mockResolvedValueOnce([row({ passwordHash: 'x' })])
    const r = await resolveAuthentikUser({ sub: 'sub-2', email: 'Alice@Example.com', email_verified: true, groups: ['authentik Admins'] }, null, { linkByEmail: true })
    expect(db.user.findMany.mock.calls[0][0]).toMatchObject({ where: { email: { equals: 'alice@example.com', mode: 'insensitive' } }, take: 2 })
    const data = db.user.update.mock.calls[0][0].data
    expect(data).toMatchObject({ provider: 'authentik', externalId: 'sub-2', role: 'admin' })
    expect(data).not.toHaveProperty('passwordHash')
    expect(r).toMatchObject({ ok: true, user: { id: 'u1', role: 'admin' }, linked: true, created: false, previousRole: 'user' })
  })

  it('refuses to guess when several accounts match the email case-insensitively', async () => {
    db.user.findMany.mockResolvedValueOnce([row(), row({ id: 'u2', email: 'ALICE@example.com' })])
    await expect(resolveAuthentikUser({ sub: 'sub-7', email: 'alice@example.com', email_verified: true }, null, { linkByEmail: true }))
      .resolves.toEqual({ ok: false, reason: 'account_conflict' })
    expect(db.user.update).not.toHaveBeenCalled()
    expect(db.user.create).not.toHaveBeenCalled()
  })

  it.each([false, undefined])('does not link by email when email_verified is %s; creates a new user with a placeholder email', async (verified) => {
    const r = await resolveAuthentikUser({ sub: 'sub-3', email: 'alice@example.com', email_verified: verified, preferred_username: 'alice' }, null, { linkByEmail: true })
    expect(db.user.findMany).not.toHaveBeenCalled()
    expect(db.user.update).not.toHaveBeenCalled()
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ provider: 'authentik', externalId: 'sub-3', email: 'sub-3@oidc.invalid', role: 'user' })
    expect(r.ok).toBe(true)
  })

  it('refuses to re-bind a user already linked to a different external identity', async () => {
    db.user.findMany.mockResolvedValueOnce([row({ provider: 'authentik', externalId: 'other-sub' })])
    await expect(resolveAuthentikUser({ sub: 'sub-4', email: 'alice@example.com', email_verified: true }, null, { linkByEmail: true }))
      .resolves.toEqual({ ok: false, reason: 'account_conflict' })
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it('keeps the existing role when the ID token has no groups claim (but still demotes on an empty one)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.user.findFirst.mockResolvedValue(row({ provider: 'authentik', externalId: 'sub-8', role: 'admin' }))
    await resolveAuthentikUser({ sub: 'sub-8' }, null)
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('role')
    expect(warn).toHaveBeenCalled()
    await resolveAuthentikUser({ sub: 'sub-8', groups: [] }, null)
    expect(db.user.update.mock.calls[1][0].data).toMatchObject({ role: 'user' })
    warn.mockRestore()
  })

  it('retries once on a P2002 race, then reports a conflict', async () => {
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' })
    db.user.create.mockRejectedValueOnce(p2002)
    db.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ provider: 'authentik', externalId: 'sub-9' }))
    await expect(resolveAuthentikUser({ sub: 'sub-9' }, null)).resolves.toMatchObject({ ok: true, created: false })
    db.user.create.mockRejectedValue(p2002)
    db.user.findFirst.mockReset().mockResolvedValue(null)
    await expect(resolveAuthentikUser({ sub: 'sub-10' }, null)).resolves.toEqual({ ok: false, reason: 'account_conflict' })
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
