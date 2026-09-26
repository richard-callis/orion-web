/**
 * M2: repo-scoped, read-only git credentials — provider API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  mintScopedCredential,
  revokeScopedCredential,
  generateSshDeployKey,
  giteaBotUsername,
  scopedRepoUrl,
  ScopingUnsupportedError,
} from './scoped-credentials'
import type { GitProviderConfig } from './index'

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown }

let calls: Call[]
let responder: (c: Call) => { status: number; body?: unknown }

beforeEach(() => {
  calls = []
  process.env.MANAGEMENT_IP = '10.0.0.5'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(c)
    const r = responder(c)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MANAGEMENT_IP
})

const gitea: GitProviderConfig = { type: 'gitea-bundled', token: 'ORG-ADMIN-TOKEN', org: 'orion' }
const github: GitProviderConfig = { type: 'github', token: 'ORG-PAT', org: 'acme' }
const gitlab: GitProviderConfig = { type: 'gitlab', url: 'https://gl.example.com', token: 'ORG-GL', org: 'acme' }
const target = { owner: 'orion', repo: 'prod-cluster', label: 'prod-cluster' }

describe('Gitea', () => {
  it('creates a bot user with read-only collaborator access and a read:repository token', async () => {
    responder = (c) => c.url.endsWith('/tokens') ? { status: 201, body: { sha1: 'SCOPED-TOKEN' } } : { status: c.method === 'PUT' ? 204 : 201, body: c.method === 'PUT' ? undefined : {} }

    const cred = await mintScopedCredential(gitea, target)

    expect(cred).toMatchObject({
      kind: 'https-token',
      secret: 'SCOPED-TOKEN',
      repoUrl: 'http://10.0.0.5:3002/orion/prod-cluster.git',
      ref: { provider: 'gitea', apiUrl: 'http://gitea:3000' },
    })
    expect(cred.username).toMatch(/^orion-env-prod-cluster-[0-9a-f]{6}$/)
    expect(cred.secret).not.toBe(gitea.token)

    const [create, collab, token] = calls
    expect(create).toMatchObject({ method: 'POST', url: 'http://gitea:3000/api/v1/admin/users' })
    expect(create.headers.Authorization).toBe('token ORG-ADMIN-TOKEN')
    expect(collab.url).toBe(`http://gitea:3000/api/v1/repos/orion/prod-cluster/collaborators/${cred.username}`)
    expect(collab.body).toEqual({ permission: 'read' })
    expect(token.headers.Authorization).toMatch(/^Basic /)
    expect(token.body).toMatchObject({ scopes: ['read:repository'] })
  })

  it('reports a non-admin provider token as unsupported', async () => {
    responder = () => ({ status: 403, body: { message: 'forbidden' } })
    await expect(mintScopedCredential(gitea, target)).rejects.toBeInstanceOf(ScopingUnsupportedError)
  })

  it('deletes the half-provisioned bot user when a later step fails', async () => {
    responder = (c) => c.method === 'PUT' ? { status: 500, body: 'boom' } : { status: c.method === 'DELETE' ? 204 : 201, body: c.method === 'DELETE' ? undefined : {} }
    await expect(mintScopedCredential(gitea, target)).rejects.toThrow(/500/)
    const del = calls.find(c => c.method === 'DELETE')
    expect(del?.url).toMatch(/\/api\/v1\/admin\/users\/orion-env-prod-cluster-[0-9a-f]{6}\?purge=true$/)
  })

  it('generates valid usernames for awkward labels', () => {
    for (const label of ['---', 'A B/C', 'x'.repeat(80), 'prod--cluster-']) {
      const u = giteaBotUsername(label)
      expect(u.length).toBeLessThanOrEqual(40)
      expect(u).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })
})

describe('GitHub', () => {
  it('adds a read-only deploy key and clones over SSH', async () => {
    responder = () => ({ status: 201, body: { id: 4242 } })
    const cred = await mintScopedCredential(github, { owner: 'acme', repo: 'prod', label: 'prod' })

    expect(cred).toMatchObject({
      kind: 'ssh-key',
      username: 'git',
      repoUrl: 'git@github.com:acme/prod.git',
      ref: { provider: 'github', owner: 'acme', repo: 'prod', keyId: 4242 },
    })
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/prod/keys')
    expect(calls[0].body).toMatchObject({ read_only: true })
    expect((calls[0].body as { key: string }).key).toMatch(/^ssh-ed25519 /)
    expect(cred.secret).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('reports a token without repo admin as unsupported', async () => {
    responder = () => ({ status: 404, body: {} })
    await expect(mintScopedCredential(github, { owner: 'acme', repo: 'prod', label: 'prod' }))
      .rejects.toBeInstanceOf(ScopingUnsupportedError)
  })

  it('scopedRepoUrl uses SSH for GitHub and HTTPS elsewhere', () => {
    expect(scopedRepoUrl(github, 'acme', 'prod')).toBe('git@github.com:acme/prod.git')
    expect(scopedRepoUrl(gitlab, 'acme', 'prod')).toBe('https://gl.example.com/acme/prod.git')
  })
})

describe('generateSshDeployKey', () => {
  it.skipIf(!existsSync('/usr/bin/ssh-keygen'))('produces an OpenSSH private key whose public half matches', () => {
    const { publicKey, privateKey } = generateSshDeployKey('orion-test')
    const dir = mkdtempSync(join(tmpdir(), 'orion-key-'))
    try {
      const keyPath = join(dir, 'id')
      writeFileSync(keyPath, privateKey, { mode: 0o600 })
      const derived = execFileSync('ssh-keygen', ['-y', '-f', keyPath]).toString().trim()
      expect(publicKey.startsWith(derived)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('GitLab', () => {
  it('creates a read_repository project deploy token', async () => {
    responder = () => ({ status: 201, body: { id: 7, username: 'gitlab+deploy-token-7', token: 'GL-SCOPED' } })
    const cred = await mintScopedCredential(gitlab, { owner: 'acme', repo: 'prod', label: 'prod' })
    expect(cred).toMatchObject({
      kind: 'https-token',
      username: 'gitlab+deploy-token-7',
      secret: 'GL-SCOPED',
      repoUrl: 'https://gl.example.com/acme/prod.git',
      ref: { provider: 'gitlab', projectPath: 'acme/prod', tokenId: 7 },
    })
    expect(calls[0].url).toBe('https://gl.example.com/api/v4/projects/acme%2Fprod/deploy_tokens')
    expect(calls[0].body).toMatchObject({ scopes: ['read_repository'] })
  })
})

describe('revokeScopedCredential', () => {
  it.each([
    [gitea, { provider: 'gitea', apiUrl: 'http://gitea:3000', botUser: 'orion-env-x-abc123' }, 'http://gitea:3000/api/v1/admin/users/orion-env-x-abc123?purge=true'],
    [github, { provider: 'github', owner: 'acme', repo: 'prod', keyId: 9 }, 'https://api.github.com/repos/acme/prod/keys/9'],
    [gitlab, { provider: 'gitlab', apiUrl: 'https://gl.example.com', projectPath: 'acme/prod', tokenId: 7 }, 'https://gl.example.com/api/v4/projects/acme%2Fprod/deploy_tokens/7'],
  ] as const)('deletes at the provider (%#)', async (config, ref, url) => {
    responder = () => ({ status: 204 })
    await revokeScopedCredential(config, ref)
    expect(calls).toEqual([expect.objectContaining({ method: 'DELETE', url })])
  })

  it('treats an already-deleted credential as revoked', async () => {
    responder = () => ({ status: 404, body: {} })
    await expect(revokeScopedCredential(github, { provider: 'github', owner: 'a', repo: 'b', keyId: 1 })).resolves.toBeUndefined()
  })

  it('surfaces other failures', async () => {
    responder = () => ({ status: 500, body: 'nope' })
    await expect(revokeScopedCredential(github, { provider: 'github', owner: 'a', repo: 'b', keyId: 1 })).rejects.toThrow(/500/)
  })
})
