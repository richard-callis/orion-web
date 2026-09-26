/**
 * M2: GET /api/environments/:id/git-provider returns the environment's
 * repo-scoped credential — never the org-wide provider token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { prisma, getGitProviderConfig, getGatewayGitCredential } = vi.hoisted(() => ({
  prisma: { environment: { findUnique: vi.fn() } },
  getGitProviderConfig: vi.fn(),
  getGatewayGitCredential: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/git-provider', () => ({ getGitProviderConfig }))
vi.mock('@/lib/environment-git-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/environment-git-credentials')>()
  return { ...actual, getGatewayGitCredential }
})

import { GET } from './route'
import { GitCredentialUnavailableError } from '@/lib/environment-git-credentials'

const env = { id: 'env-1', name: 'prod', gatewayToken: 'mcga_env1', gitOwner: 'orion', gitRepo: 'prod' }

function get(auth?: string) {
  return GET(
    new NextRequest('http://x/api/environments/env-1/git-provider', { headers: auth ? { authorization: auth } : {} }),
    { params: Promise.resolve({ id: 'env-1' }) },
  )
}

beforeEach(() => {
  prisma.environment.findUnique.mockReset().mockResolvedValue(env)
  getGitProviderConfig.mockReset().mockResolvedValue({ type: 'gitea-bundled', token: 'ORG-ADMIN-TOKEN', org: 'orion' })
  getGatewayGitCredential.mockReset()
})

describe('GET /api/environments/:id/git-provider', () => {
  it('rejects a wrong gateway token', async () => {
    const res = await get('Bearer mcga_other')
    expect(res.status).toBe(401)
    expect(getGatewayGitCredential).not.toHaveBeenCalled()
  })

  it('returns the scoped https credential (and legacy fields scoped to the repo)', async () => {
    getGatewayGitCredential.mockResolvedValue({
      kind: 'https-token', username: 'orion-env-prod-abc123', secret: 'SCOPED', repoUrl: 'http://10.0.0.5:3002/orion/prod.git', orgTokenFallback: false,
    })
    const res = await get('Bearer mcga_env1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      type: 'gitea-bundled',
      org: 'orion',
      url: 'http://10.0.0.5:3002/orion/prod.git',
      token: 'SCOPED',
      credential: {
        kind: 'https-token',
        repoUrl: 'http://10.0.0.5:3002/orion/prod.git',
        username: 'orion-env-prod-abc123',
        password: 'SCOPED',
        orgTokenFallback: false,
      },
    })
    expect(JSON.stringify(body)).not.toContain('ORG-ADMIN-TOKEN')
  })

  it('returns an ssh deploy key without a legacy token', async () => {
    getGatewayGitCredential.mockResolvedValue({
      kind: 'ssh-key', username: 'git', secret: '-----BEGIN OPENSSH PRIVATE KEY-----\n...', repoUrl: 'git@github.com:acme/prod.git', orgTokenFallback: false,
    })
    const body = await (await get('Bearer mcga_env1')).json()
    expect(body.token).toBe('')
    expect(body.credential).toMatchObject({ kind: 'ssh-key', sshPrivateKey: expect.stringContaining('OPENSSH') })
    expect(body.credential.password).toBeUndefined()
  })

  it('409s with the reason when no scoped credential can be issued', async () => {
    getGatewayGitCredential.mockRejectedValue(new GitCredentialUnavailableError('not a site admin'))
    const res = await get('Bearer mcga_env1')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('not a site admin')
  })

  it('502s without leaking provider details on other failures', async () => {
    getGatewayGitCredential.mockRejectedValue(new Error('Gitea POST /admin/users → 500: token=ORG-ADMIN-TOKEN'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await get('Bearer mcga_env1')
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('ORG-ADMIN-TOKEN')
    err.mockRestore()
  })
})
