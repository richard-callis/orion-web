import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({ systemSetting: { findUnique: vi.fn() } }))
vi.mock('./db', () => ({ prisma: db }))
vi.mock('./encryption', () => ({ PREFIX: 'enc:', decrypt: () => 'admin-token' }))

import { readVaultSecret, NoVaultTokenError } from './vault'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  db.systemSetting.findUnique.mockResolvedValue({ value: 'enc:x' })
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { data: { client_id: 'abc' } } })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('readVaultSecret', () => {
  it('reads KV v2 with the admin token and normalises the secret/ prefix', async () => {
    await expect(readVaultSecret('secret/orion/authentik-oidc')).resolves.toEqual({ client_id: 'abc' })
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/v1\/secret\/data\/orion\/authentik-oidc$/)
    expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('admin-token')
  })

  it('returns null for a missing secret and throws for other failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(404, { errors: [] }))
    await expect(readVaultSecret('x')).resolves.toBeNull()
    vi.mocked(fetch).mockResolvedValueOnce(json(503, { errors: ['sealed'] }))
    await expect(readVaultSecret('x')).rejects.toThrow(/503/)
  })

  it('does not use VAULT_TOKEN unless the caller opts in, and then only without an admin token setting', async () => {
    db.systemSetting.findUnique.mockResolvedValue(null)
    vi.stubEnv('VAULT_TOKEN', 'env-token')
    await expect(readVaultSecret('x')).rejects.toBeInstanceOf(NoVaultTokenError)
    expect(fetch).not.toHaveBeenCalled()
    await readVaultSecret('x', { allowEnvToken: true })
    expect(((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>)['X-Vault-Token']).toBe('env-token')
    vi.stubEnv('VAULT_TOKEN', '')
    await expect(readVaultSecret('x', { allowEnvToken: true })).rejects.toBeInstanceOf(NoVaultTokenError)
  })

  it('does not swallow an unencrypted admin token by falling back to VAULT_TOKEN', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ value: 'plaintext' })
    vi.stubEnv('VAULT_TOKEN', 'env-token')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(readVaultSecret('x', { allowEnvToken: true })).rejects.toThrow(/encrypted/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
