/**
 * M2: per-environment gateway git credentials — lifecycle and fallback policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const { prisma, getGitProviderConfig, mintScopedCredential, revokeScopedCredential } = vi.hoisted(() => ({
  prisma: {
    environmentGitCredential: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    systemSetting: { findUnique: vi.fn() },
  },
  getGitProviderConfig: vi.fn(),
  mintScopedCredential: vi.fn(),
  revokeScopedCredential: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/encryption', () => ({
  encrypt: (s: string) => `enc:v1:${s}`,
  decrypt: (s: string) => {
    if (!s.startsWith('enc:v1:')) throw new Error('bad ciphertext')
    return s.slice('enc:v1:'.length)
  },
}))
vi.mock('@/lib/git-provider', () => ({ getGitProviderConfig }))
vi.mock('@/lib/git-provider/scoped-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/git-provider/scoped-credentials')>()
  return { ...actual, mintScopedCredential, revokeScopedCredential }
})

import {
  getGatewayGitCredential,
  revokeEnvironmentGitCredential,
  GitCredentialUnavailableError,
  ORG_TOKEN_FALLBACK_SETTING,
} from './environment-git-credentials'
import { ScopingUnsupportedError } from '@/lib/git-provider/scoped-credentials'

const env = { id: 'env-1', name: 'Prod Cluster', gitOwner: 'orion', gitRepo: 'prod-cluster' }
const config = { type: 'gitea-bundled', token: 'ORG-ADMIN-TOKEN', org: 'orion' }
const REPO_URL = 'http://10.0.0.5:3002/orion/prod-cluster.git'
const giteaRef = { provider: 'gitea', apiUrl: 'http://gitea:3000', botUser: 'orion-env-prod-abc123' }

beforeEach(() => {
  process.env.MANAGEMENT_IP = '10.0.0.5'
  getGitProviderConfig.mockReset().mockResolvedValue(config)
  prisma.environmentGitCredential.findUnique.mockReset().mockResolvedValue(null)
  prisma.environmentGitCredential.create.mockReset().mockResolvedValue({})
  prisma.environmentGitCredential.deleteMany.mockReset().mockResolvedValue({ count: 1 })
  prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null)
  mintScopedCredential.mockReset().mockResolvedValue({
    kind: 'https-token', username: 'orion-env-prod-abc123', secret: 'SCOPED', repoUrl: REPO_URL, ref: giteaRef,
  })
  revokeScopedCredential.mockReset().mockResolvedValue(undefined)
})

describe('getGatewayGitCredential', () => {
  it('mints, stores encrypted, and never returns the org token', async () => {
    const cred = await getGatewayGitCredential(env)
    expect(cred).toEqual({ kind: 'https-token', username: 'orion-env-prod-abc123', secret: 'SCOPED', repoUrl: REPO_URL, orgTokenFallback: false })
    expect(mintScopedCredential).toHaveBeenCalledWith(config, { owner: 'orion', repo: 'prod-cluster', label: 'prod-cluster' })
    const stored = prisma.environmentGitCredential.create.mock.calls[0][0].data
    expect(stored).toMatchObject({ environmentId: 'env-1', provider: 'gitea', secret: 'enc:v1:SCOPED', repoUrl: REPO_URL })
    expect(JSON.stringify(stored)).not.toContain('ORG-ADMIN-TOKEN')
  })

  it('reuses a stored credential for the same repo and provider', async () => {
    prisma.environmentGitCredential.findUnique.mockResolvedValue({
      id: 'c1', provider: 'gitea', kind: 'https-token', username: 'bot', secret: 'enc:v1:STORED', repoUrl: REPO_URL, providerRef: giteaRef,
    })
    const cred = await getGatewayGitCredential(env)
    expect(cred.secret).toBe('STORED')
    expect(mintScopedCredential).not.toHaveBeenCalled()
  })

  it('replaces a credential for a different repo (revoking the old one)', async () => {
    prisma.environmentGitCredential.findUnique.mockResolvedValue({
      id: 'c1', provider: 'gitea', kind: 'https-token', username: 'bot', secret: 'enc:v1:OLD', repoUrl: 'http://10.0.0.5:3002/orion/old.git', providerRef: giteaRef,
    })
    const cred = await getGatewayGitCredential(env)
    expect(cred.secret).toBe('SCOPED')
    expect(prisma.environmentGitCredential.deleteMany).toHaveBeenCalledWith({ where: { id: 'c1' } })
    expect(revokeScopedCredential).toHaveBeenCalledWith(config, giteaRef)
  })

  it('replaces a credential that no longer decrypts', async () => {
    prisma.environmentGitCredential.findUnique.mockResolvedValue({
      id: 'c1', provider: 'gitea', kind: 'https-token', username: 'bot', secret: 'garbage', repoUrl: REPO_URL, providerRef: giteaRef,
    })
    expect((await getGatewayGitCredential(env)).secret).toBe('SCOPED')
    expect(mintScopedCredential).toHaveBeenCalled()
  })

  it('refuses the org token when scoping is unsupported and the fallback is off', async () => {
    mintScopedCredential.mockRejectedValue(new ScopingUnsupportedError('not a site admin'))
    await expect(getGatewayGitCredential(env)).rejects.toBeInstanceOf(GitCredentialUnavailableError)
    await expect(getGatewayGitCredential(env)).rejects.toThrow(ORG_TOKEN_FALLBACK_SETTING)
  })

  it('hands out the org token, flagged and unstored, only when the fallback is on', async () => {
    mintScopedCredential.mockRejectedValue(new ScopingUnsupportedError('not a site admin'))
    prisma.systemSetting.findUnique.mockResolvedValue({ key: ORG_TOKEN_FALLBACK_SETTING, value: true })
    const cred = await getGatewayGitCredential(env)
    expect(cred).toMatchObject({ secret: 'ORG-ADMIN-TOKEN', orgTokenFallback: true, repoUrl: REPO_URL })
    expect(prisma.environmentGitCredential.create).not.toHaveBeenCalled()
  })

  it('does not fall back on transient provider errors', async () => {
    mintScopedCredential.mockRejectedValue(new Error('Gitea → 502'))
    prisma.systemSetting.findUnique.mockResolvedValue({ key: ORG_TOKEN_FALLBACK_SETTING, value: true })
    await expect(getGatewayGitCredential(env)).rejects.toThrow('502')
  })

  it('keeps the winner and revokes its own credential when a concurrent request stored first', async () => {
    prisma.environmentGitCredential.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c2', provider: 'gitea', kind: 'https-token', username: 'winner', secret: 'enc:v1:WINNER', repoUrl: REPO_URL, providerRef: {} })
    prisma.environmentGitCredential.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const cred = await getGatewayGitCredential(env)
    expect(cred.secret).toBe('WINNER')
    expect(revokeScopedCredential).toHaveBeenCalledWith(config, giteaRef)
  })

  it('errors when no git provider is configured', async () => {
    getGitProviderConfig.mockResolvedValue(null)
    await expect(getGatewayGitCredential(env)).rejects.toBeInstanceOf(GitCredentialUnavailableError)
  })
})

describe('revokeEnvironmentGitCredential', () => {
  it('deletes the row and revokes at the provider', async () => {
    prisma.environmentGitCredential.findUnique.mockResolvedValue({ id: 'c1', provider: 'gitea', providerRef: giteaRef })
    await revokeEnvironmentGitCredential('env-1')
    expect(prisma.environmentGitCredential.deleteMany).toHaveBeenCalledWith({ where: { id: 'c1' } })
    expect(revokeScopedCredential).toHaveBeenCalledWith(config, giteaRef)
  })

  it('is a no-op when there is no credential', async () => {
    await revokeEnvironmentGitCredential('env-1')
    expect(revokeScopedCredential).not.toHaveBeenCalled()
  })

  it('still deletes the row when the provider call fails', async () => {
    prisma.environmentGitCredential.findUnique.mockResolvedValue({ id: 'c1', provider: 'gitea', providerRef: giteaRef })
    revokeScopedCredential.mockRejectedValue(new Error('provider down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(revokeEnvironmentGitCredential('env-1')).resolves.toBeUndefined()
    expect(prisma.environmentGitCredential.deleteMany).toHaveBeenCalled()
    err.mockRestore()
  })
})
