import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('./db', () => ({ prisma: { environment: { findMany: (...a: unknown[]) => findMany(...a) } } }))

import { findEnvironmentByFederationToken } from './federation-auth'

beforeEach(() => {
  findMany.mockReset()
  // Rows as returned through the encryption middleware (already decrypted).
  findMany.mockResolvedValue([
    { id: 'hub', federationToken: 'token-hub' },
    { id: 'spoke', federationToken: 'token-spoke' },
    { id: 'broken', federationToken: null },
  ])
})

describe('findEnvironmentByFederationToken', () => {
  it('matches the environment whose decrypted token equals the bearer', async () => {
    await expect(findEnvironmentByFederationToken('token-spoke')).resolves.toEqual({ id: 'spoke' })
  })

  it('rejects unknown, prefix, and empty tokens', async () => {
    await expect(findEnvironmentByFederationToken('token-nope')).resolves.toBeNull()
    await expect(findEnvironmentByFederationToken('token-hu')).resolves.toBeNull()
    await expect(findEnvironmentByFederationToken('')).resolves.toBeNull()
  })

  it('does not match on the stored ciphertext form', async () => {
    findMany.mockResolvedValue([{ id: 'x', federationToken: 'token-x' }])
    await expect(findEnvironmentByFederationToken('enc:v1:whatever')).resolves.toBeNull()
  })
})
