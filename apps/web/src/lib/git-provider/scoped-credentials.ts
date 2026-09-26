/**
 * M2: repo-scoped, read-only git credentials for environment gateways.
 *
 * A gateway only needs git access so ArgoCD can clone its environment's repo.
 * Instead of handing it the org-wide provider token, mint the narrowest
 * credential each provider supports:
 *
 *   gitea / gitea-bundled  a dedicated bot user with `read` collaborator access
 *                          on the env repo only, plus a `read:repository` token
 *                          (needs a site-admin provider token)
 *   github                 a read-only SSH deploy key on the env repo; ArgoCD
 *                          clones over SSH (github.com's host key ships with ArgoCD)
 *   gitlab                 a project deploy token with `read_repository`
 *
 * When a provider or token can't do this, mint* throws ScopingUnsupportedError
 * and the caller decides whether the documented org-token fallback applies
 * (see lib/environment-git-credentials.ts).
 */

import { generateKeyPairSync, randomBytes } from 'crypto'
import type { GitProviderConfig } from './index'

export type CredentialKind = 'https-token' | 'ssh-key'

export type ProviderRef =
  | { provider: 'gitea'; apiUrl: string; botUser: string }
  | { provider: 'github'; owner: string; repo: string; keyId: number }
  | { provider: 'gitlab'; apiUrl: string; projectPath: string; tokenId: number }

export interface ScopedCredential {
  kind: CredentialKind
  username: string
  /** Token (https-token) or OpenSSH private key (ssh-key). Plaintext. */
  secret: string
  /** Exact URL ArgoCD clones — must equal the Application's repoURL. */
  repoUrl: string
  ref: ProviderRef
}

/** The provider or its token can't mint a scoped credential. */
export class ScopingUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopingUnsupportedError'
  }
}

export interface RepoTarget {
  owner: string
  repo: string
  /** Short, stable label for naming the credential (env slug). */
  label: string
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/** ORION-side API base for a Gitea config (bundled Gitea is on the compose network). */
function giteaApiBase(config: GitProviderConfig): string {
  return (config.type === 'gitea-bundled' ? 'http://gitea:3000' : (config.url ?? 'http://gitea:3000')).replace(/\/$/, '')
}

function gitlabApiBase(config: GitProviderConfig): string {
  return (config.url ?? 'https://gitlab.com').replace(/\/$/, '')
}

/**
 * Cluster-reachable HTTPS base for cloning. Bundled Gitea is reached through the
 * management IP (port 3002) so it works air-gapped; external providers use the
 * URL configured in the setup wizard.
 */
export function clusterGitBase(config: GitProviderConfig): string {
  if (config.type === 'gitea-bundled') {
    const ip = process.env.MANAGEMENT_IP
    if (!ip) throw new Error('MANAGEMENT_IP not set — cannot derive cluster-reachable Gitea URL')
    return `http://${ip}:3002`
  }
  return (config.url ?? (config.type === 'github' ? 'https://github.com' : '')).replace(/\/$/, '')
}

/** HTTPS clone URL for owner/repo. */
export function httpsRepoUrl(config: GitProviderConfig, owner: string, repo: string): string {
  return `${clusterGitBase(config)}/${owner}/${repo}.git`
}

/**
 * The URL ArgoCD should clone when a scoped credential is in use. GitHub has no
 * API for repo-scoped HTTPS tokens, so GitHub environments clone over SSH with a
 * deploy key; everything else clones over HTTPS.
 */
export function scopedRepoUrl(config: GitProviderConfig, owner: string, repo: string): string {
  return config.type === 'github' ? `git@github.com:${owner}/${repo}.git` : httpsRepoUrl(config, owner, repo)
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function call<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new HttpError(res.status, `${label} → ${res.status}: ${detail.slice(0, 300)}`)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const isForbidden = (err: unknown) => err instanceof HttpError && (err.status === 401 || err.status === 403)
const isNotFound = (err: unknown) => err instanceof HttpError && err.status === 404

// ── Gitea ────────────────────────────────────────────────────────────────────

/** Gitea usernames: alnum plus single '-', no leading/trailing '-', ≤ 40 chars. */
export function giteaBotUsername(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 22).replace(/-+$/, '')
  return `orion-env-${slug || 'env'}-${randomBytes(3).toString('hex')}`
}

async function mintGitea(config: GitProviderConfig, target: RepoTarget): Promise<ScopedCredential> {
  const api = `${giteaApiBase(config)}/api/v1`
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: `token ${config.token}` }
  const username = giteaBotUsername(target.label)
  // Satisfies Gitea's optional password-complexity settings; never used after
  // the token is issued.
  const password = `${randomBytes(24).toString('base64url')}aA1!`

  try {
    await call(`${api}/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        username,
        email: `${username}@noreply.orion.local`,
        password,
        must_change_password: false,
        send_notify: false,
        visibility: 'private',
      }),
    }, 'Gitea create bot user')
  } catch (err) {
    if (isForbidden(err)) {
      throw new ScopingUnsupportedError('Gitea provider token is not a site admin, so it cannot create a scoped bot user')
    }
    throw err
  }

  const ref: ProviderRef = { provider: 'gitea', apiUrl: giteaApiBase(config), botUser: username }
  try {
    await call(`${api}/repos/${enc(target.owner)}/${enc(target.repo)}/collaborators/${enc(username)}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ permission: 'read' }),
    }, 'Gitea add read collaborator')

    const basic = Buffer.from(`${username}:${password}`).toString('base64')
    const token = await call<{ sha1: string }>(`${api}/users/${enc(username)}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
      body: JSON.stringify({ name: 'argocd-read', scopes: ['read:repository'] }),
    }, 'Gitea create bot token')

    return {
      kind: 'https-token',
      username,
      secret: token.sha1,
      repoUrl: httpsRepoUrl(config, target.owner, target.repo),
      ref,
    }
  } catch (err) {
    // Don't leave a half-provisioned bot user behind.
    await revokeScopedCredential(config, ref).catch(() => {})
    throw err
  }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length)
  return Buffer.concat([len, buf])
}

function sshUint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

/**
 * Generate an ed25519 key pair as an OpenSSH public key line and an unencrypted
 * OpenSSH-format private key (the format every git/ssh client, including
 * ArgoCD's repo-server, accepts).
 */
export function generateSshDeployKey(comment: string): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string }
  const pub = Buffer.from(pubJwk.x, 'base64url')
  const seed = Buffer.from(privJwk.d, 'base64url')

  const keyType = Buffer.from('ssh-ed25519')
  const pubBlob = Buffer.concat([sshString(keyType), sshString(pub)])

  const check = randomBytes(4).readUInt32BE(0)
  let priv = Buffer.concat([
    sshUint32(check),
    sshUint32(check),
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment)),
  ])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    sshUint32(1),
    sshString(pubBlob),
    sshString(priv),
  ]).toString('base64')

  const lines = body.match(/.{1,70}/g) ?? []
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
  }
}

const GITHUB_API = 'https://api.github.com'

function githubHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function mintGitHub(config: GitProviderConfig, target: RepoTarget): Promise<ScopedCredential> {
  const title = `orion-argocd-${target.label}`.slice(0, 100)
  const { publicKey, privateKey } = generateSshDeployKey(title)
  let key: { id: number }
  try {
    key = await call<{ id: number }>(`${GITHUB_API}/repos/${enc(target.owner)}/${enc(target.repo)}/keys`, {
      method: 'POST',
      headers: githubHeaders(config.token),
      body: JSON.stringify({ title, key: publicKey, read_only: true }),
    }, 'GitHub create deploy key')
  } catch (err) {
    if (isForbidden(err) || isNotFound(err)) {
      throw new ScopingUnsupportedError('GitHub token cannot manage deploy keys on this repo (needs admin on the repo)')
    }
    throw err
  }
  return {
    kind: 'ssh-key',
    username: 'git',
    secret: privateKey,
    repoUrl: scopedRepoUrl(config, target.owner, target.repo),
    ref: { provider: 'github', owner: target.owner, repo: target.repo, keyId: key.id },
  }
}

// ── GitLab ───────────────────────────────────────────────────────────────────

async function mintGitLab(config: GitProviderConfig, target: RepoTarget): Promise<ScopedCredential> {
  const apiUrl = gitlabApiBase(config)
  const projectPath = `${target.owner}/${target.repo}`
  let token: { id: number; username: string; token: string }
  try {
    token = await call(`${apiUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/deploy_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': config.token },
      body: JSON.stringify({ name: `orion-argocd-${target.label}`.slice(0, 100), scopes: ['read_repository'] }),
    }, 'GitLab create deploy token')
  } catch (err) {
    if (isForbidden(err) || isNotFound(err)) {
      throw new ScopingUnsupportedError('GitLab token cannot create deploy tokens on this project (needs Maintainer)')
    }
    throw err
  }
  return {
    kind: 'https-token',
    username: token.username,
    secret: token.token,
    repoUrl: httpsRepoUrl(config, target.owner, target.repo),
    ref: { provider: 'gitlab', apiUrl, projectPath, tokenId: token.id },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function enc(s: string): string {
  return encodeURIComponent(s)
}

export async function mintScopedCredential(config: GitProviderConfig, target: RepoTarget): Promise<ScopedCredential> {
  switch (config.type) {
    case 'gitea':
    case 'gitea-bundled':
      return mintGitea(config, target)
    case 'github':
      return mintGitHub(config, target)
    case 'gitlab':
      return mintGitLab(config, target)
    default:
      throw new ScopingUnsupportedError(`Git provider type "${(config as { type: string }).type}" has no scoped credentials`)
  }
}

/** Revoke at the provider. Already-gone (404) counts as revoked. */
export async function revokeScopedCredential(config: GitProviderConfig, ref: ProviderRef): Promise<void> {
  try {
    switch (ref.provider) {
      case 'gitea':
        await call(`${ref.apiUrl}/api/v1/admin/users/${enc(ref.botUser)}?purge=true`, {
          method: 'DELETE',
          headers: { Authorization: `token ${config.token}` },
        }, 'Gitea delete bot user')
        return
      case 'github':
        await call(`${GITHUB_API}/repos/${enc(ref.owner)}/${enc(ref.repo)}/keys/${ref.keyId}`, {
          method: 'DELETE',
          headers: githubHeaders(config.token),
        }, 'GitHub delete deploy key')
        return
      case 'gitlab':
        await call(`${ref.apiUrl}/api/v4/projects/${encodeURIComponent(ref.projectPath)}/deploy_tokens/${ref.tokenId}`, {
          method: 'DELETE',
          headers: { 'PRIVATE-TOKEN': config.token },
        }, 'GitLab delete deploy token')
        return
    }
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
}
