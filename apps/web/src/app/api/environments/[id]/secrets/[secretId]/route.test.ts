/**
 * PATCH /api/environments/:id/secrets/:secretId — rotating one key must not
 * wipe the others; blank values mean "keep"; deletes are explicit only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { managedSecret, vault, admin } = vi.hoisted(() => ({
  managedSecret: { findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  vault: { updateVaultSecret: vi.fn() },
  admin: { ok: true },
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: vi.fn(async () => { if (!admin.ok) throw new Error('Unauthorized'); return { id: 'admin-1' } }),
}))
vi.mock('@/lib/db', () => ({ prisma: { managedSecret } }))
vi.mock('@/lib/vault', () => vault)

import { PATCH, DELETE } from './route'

const params = { params: Promise.resolve({ id: 'env-1', secretId: 's-1' }) }
const patch = (body: unknown) =>
  PATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify(body) }), params)

beforeEach(() => {
  admin.ok = true
  managedSecret.findFirst.mockReset().mockResolvedValue({
    remoteRef: 'myapp/db',
    dataKeys: [
      { remoteKey: 'user', secretKey: 'DB_USER' },
      { remoteKey: 'password', secretKey: 'DB_PASSWORD' },
    ],
  })
  managedSecret.update.mockReset().mockImplementation(async ({ data }) => ({ id: 's-1', ...data }))
  managedSecret.deleteMany.mockReset().mockResolvedValue({ count: 1 })
  vault.updateVaultSecret.mockReset().mockResolvedValue(['user', 'password'])
})

describe('secret PATCH', () => {
  it('rotating one key writes only that key and keeps all mappings', async () => {
    const res = await patch({
      secretValues: [
        { vaultKey: 'user', value: '', k8sKey: 'DB_USER' },
        { vaultKey: 'password', value: 's3cret', k8sKey: 'DB_PASSWORD' },
      ],
      removeKeys: [],
    })
    expect(res.status).toBe(200)
    expect(vault.updateVaultSecret).toHaveBeenCalledWith('myapp/db', { password: 's3cret' }, [])
    const data = managedSecret.update.mock.calls[0][0].data
    expect(data.dataKeys).toEqual([
      { remoteKey: 'user', secretKey: 'DB_USER' },
      { remoteKey: 'password', secretKey: 'DB_PASSWORD' },
    ])
    expect(data.status).toBe('applied')
  })

  it('submitting only blank values never touches Vault (no silent wipe)', async () => {
    await patch({ secretValues: [{ vaultKey: 'user', value: '' }, { vaultKey: 'password', value: '' }] })
    expect(vault.updateVaultSecret).not.toHaveBeenCalled()
    const data = managedSecret.update.mock.calls[0][0].data
    expect(data.dataKeys).toHaveLength(2)
    expect(data.status).toBeUndefined()
  })

  it('a single-row update keeps keys that were not submitted', async () => {
    await patch({ secretValues: [{ vaultKey: 'password', value: 'x' }] })
    expect(managedSecret.update.mock.calls[0][0].data.dataKeys).toEqual([
      { remoteKey: 'user', secretKey: 'DB_USER' },
      { remoteKey: 'password', secretKey: 'DB_PASSWORD' },
    ])
  })

  it('deletes a key only when listed in removeKeys', async () => {
    await patch({ secretValues: [{ vaultKey: 'password', value: '' }], removeKeys: ['user'] })
    expect(vault.updateVaultSecret).toHaveBeenCalledWith('myapp/db', {}, ['user'])
    expect(managedSecret.update.mock.calls[0][0].data.dataKeys).toEqual([{ remoteKey: 'password', secretKey: 'DB_PASSWORD' }])
  })

  it('adds a new key alongside existing ones', async () => {
    await patch({ secretValues: [{ vaultKey: 'port', value: '5432', k8sKey: 'DB_PORT' }] })
    expect(vault.updateVaultSecret).toHaveBeenCalledWith('myapp/db', { port: '5432' }, [])
    expect(managedSecret.update.mock.calls[0][0].data.dataKeys).toHaveLength(3)
  })

  it('404s for a secret belonging to another environment', async () => {
    managedSecret.findFirst.mockResolvedValue(null)
    const res = await patch({ secretValues: [{ vaultKey: 'password', value: 'x' }] })
    expect(res.status).toBe(404)
    expect(managedSecret.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's-1', environmentId: 'env-1' } }))
    expect(vault.updateVaultSecret).not.toHaveBeenCalled()
  })

  it('returns 502 and leaves the DB alone when Vault fails', async () => {
    vault.updateVaultSecret.mockRejectedValue(new Error('sealed'))
    const res = await patch({ secretValues: [{ vaultKey: 'password', value: 'x' }] })
    expect(res.status).toBe(502)
    expect(managedSecret.update).not.toHaveBeenCalled()
  })

  it('requires admin', async () => {
    admin.ok = false
    expect((await patch({})).status).toBe(401)
  })
})

describe('secret DELETE', () => {
  it('is scoped to the environment', async () => {
    managedSecret.deleteMany.mockResolvedValue({ count: 0 })
    const res = await DELETE(new NextRequest('http://x', { method: 'DELETE' }), params)
    expect(res.status).toBe(404)
    expect(managedSecret.deleteMany).toHaveBeenCalledWith({ where: { id: 's-1', environmentId: 'env-1' } })
  })
})
