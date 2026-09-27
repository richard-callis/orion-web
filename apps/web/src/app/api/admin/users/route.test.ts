/**
 * Admin user management: create, duplicate handling, lockout guards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'

const { admin, userModel } = vi.hoisted(() => ({
  admin: { ok: true },
  userModel: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), count: vi.fn(), findMany: vi.fn() },
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: vi.fn(async () => { if (!admin.ok) throw new Error('Unauthorized'); return { id: 'admin-1' } }),
}))
vi.mock('@/lib/db', () => ({ prisma: { user: userModel } }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}), getClientIp: () => null, getUserAgent: () => null }))
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }))

import { POST, GET } from './route'
import { PATCH } from './[id]/route'

const post = (body: unknown) => POST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) }))
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

const valid = { username: 'alice', email: 'alice@example.com', password: 'correct-horse-battery', role: 'user' }
const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' })

beforeEach(() => {
  admin.ok = true
  for (const fn of Object.values(userModel)) fn.mockReset()
  userModel.create.mockImplementation(async ({ data }) => ({ id: 'u-new', ...data, passwordHash: undefined }))
  userModel.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }))
})

describe('POST /api/admin/users', () => {
  it('creates a local user with a hashed password', async () => {
    const res = await post(valid)
    expect(res.status).toBe(201)
    const data = userModel.create.mock.calls[0][0].data
    expect(data).toMatchObject({ username: 'alice', email: 'alice@example.com', passwordHash: 'hashed', role: 'user', provider: 'local' })
    expect(data.password).toBeUndefined()
  })

  it('rejects short passwords', async () => {
    expect((await post({ ...valid, password: 'short' })).status).toBe(400)
    expect(userModel.create).not.toHaveBeenCalled()
  })

  it('returns 409 on duplicate username/email instead of 500', async () => {
    userModel.create.mockRejectedValue(p2002())
    expect((await post(valid)).status).toBe(409)
  })

  it('returns 401 (not 500) for non-admins', async () => {
    admin.ok = false
    expect((await post(valid)).status).toBe(401)
    expect((await GET()).status).toBe(401)
  })
})

describe('PATCH /api/admin/users/:id', () => {
  it('refuses to demote the last active admin', async () => {
    userModel.findUnique.mockResolvedValue({ role: 'admin', active: true })
    userModel.count.mockResolvedValue(1)
    expect((await patch('admin-1', { role: 'user' })).status).toBe(400)
    expect(userModel.update).not.toHaveBeenCalled()
  })

  it('refuses to deactivate the last active admin', async () => {
    userModel.findUnique.mockResolvedValue({ role: 'admin', active: true })
    userModel.count.mockResolvedValue(1)
    expect((await patch('admin-1', { active: false })).status).toBe(400)
  })

  it('allows demoting an admin when another active admin exists', async () => {
    userModel.findUnique.mockResolvedValue({ role: 'admin', active: true })
    userModel.count.mockResolvedValue(2)
    expect((await patch('u1', { role: 'user' })).status).toBe(200)
  })

  it('password resets require 12+ characters', async () => {
    expect((await patch('u1', { password: 'eightchr' })).status).toBe(400)
    expect((await patch('u1', { password: 'twelve-chars!' })).status).toBe(200)
    expect(userModel.update.mock.calls[0][0].data).toEqual({ passwordHash: 'hashed' })
  })

  it('returns provider so the UI badge survives an edit', async () => {
    await patch('u1', { role: 'readonly' })
    expect(userModel.update.mock.calls[0][0].select.provider).toBe(true)
  })

  it('returns 409 on duplicate email', async () => {
    userModel.update.mockRejectedValue(p2002())
    expect((await patch('u1', { email: 'taken@example.com' })).status).toBe(409)
  })
})
