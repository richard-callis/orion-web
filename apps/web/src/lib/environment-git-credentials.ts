/**
 * M2: per-environment git credentials for gateways.
 *
 * Each environment's gateway gets a read-only credential scoped to that
 * environment's repo (lib/git-provider/scoped-credentials.ts), stored encrypted
 * in EnvironmentGitCredential. Lifecycle:
 *
 *   - minted lazily on first use (GET /api/environments/:id/git-provider)
 *   - rotated when a gateway first joins with a new join token, or when its
 *     gateway token is rotated: the old credential is revoked and the next fetch
 *     mints a fresh one
 *   - revoked at the provider when the environment is deleted
 *
 * Fallback: if the provider/token can't mint scoped credentials (external Gitea
 * with a non-admin token, a GitHub token without repo admin, ...), the org-wide
 * token is handed out ONLY when the SystemSetting `git.gateway.allowOrgTokenFallback`
 * is true. It is never stored per-environment. Default: refuse.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import { getGitProviderConfig, type GitProviderConfig } from '@/lib/git-provider'
import {
  mintScopedCredential,
  revokeScopedCredential,
  scopedRepoUrl,
  httpsRepoUrl,
  ScopingUnsupportedError,
  type ScopedCredential,
  type ProviderRef,
  type CredentialKind,
} from '@/lib/git-provider/scoped-credentials'

export const ORG_TOKEN_FALLBACK_SETTING = 'git.gateway.allowOrgTokenFallback'

export interface GatewayGitCredential {
  kind: CredentialKind
  username: string
  secret: string
  repoUrl: string
  /** true only for the opt-in org-token fallback */
  orgTokenFallback: boolean
}

export class GitCredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCredentialUnavailableError'
  }
}

/** Same defaults as cluster-bootstrap's ensureGitRepo. */
export function resolveEnvironmentRepo(env: { name: string; gitOwner: string | null; gitRepo: string | null }) {
  return {
    owner: env.gitOwner ?? 'orion',
    repo: env.gitRepo ?? env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  }
}

function envLabel(env: { name: string; id: string }): string {
  const slug = env.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || env.id.slice(0, 12)
}

async function orgTokenFallbackAllowed(): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key: ORG_TOKEN_FALLBACK_SETTING } })
  return row?.value === true || row?.value === 'true'
}

function orgFallbackCredential(config: GitProviderConfig, owner: string, repo: string): GatewayGitCredential {
  return {
    kind: 'https-token',
    username: config.type === 'github' ? 'x-access-token' : config.type === 'gitlab' ? 'oauth2' : 'orion',
    secret: config.token,
    repoUrl: httpsRepoUrl(config, owner, repo),
    orgTokenFallback: true,
  }
}

/**
 * Get this environment's gateway credential, minting it if needed.
 * Throws GitCredentialUnavailableError when no git provider is configured, or
 * scoping is unsupported and the fallback is off.
 */
export async function getGatewayGitCredential(
  env: { id: string; name: string; gitOwner: string | null; gitRepo: string | null },
): Promise<GatewayGitCredential> {
  const config = await getGitProviderConfig()
  if (!config) throw new GitCredentialUnavailableError('Git provider not configured')

  const { owner, repo } = resolveEnvironmentRepo(env)
  const expectedUrl = scopedRepoUrl(config, owner, repo)

  const existing = await prisma.environmentGitCredential.findUnique({ where: { environmentId: env.id } })
  if (existing) {
    let secret: string | null = null
    try { secret = decrypt(existing.secret) } catch { secret = null }
    // Reuse only if it still decrypts, belongs to the current provider, and
    // points at the env's current repo. Otherwise replace it.
    if (secret && existing.repoUrl === expectedUrl && sameProvider(existing.provider, config)) {
      return { kind: existing.kind as CredentialKind, username: existing.username, secret, repoUrl: existing.repoUrl, orgTokenFallback: false }
    }
    await revokeEnvironmentGitCredential(env.id, config)
  }

  let minted: ScopedCredential
  try {
    minted = await mintScopedCredential(config, { owner, repo, label: envLabel(env) })
  } catch (err) {
    if (err instanceof ScopingUnsupportedError) {
      if (await orgTokenFallbackAllowed()) {
        console.warn(`[git-cred] ${err.message} — using org-token fallback for "${env.name}" (${ORG_TOKEN_FALLBACK_SETTING}=true)`)
        return orgFallbackCredential(config, owner, repo)
      }
      throw new GitCredentialUnavailableError(
        `${err.message}. Refusing to hand the gateway the org-wide token; set SystemSetting ${ORG_TOKEN_FALLBACK_SETTING}=true to allow it.`,
      )
    }
    throw err
  }

  try {
    await prisma.environmentGitCredential.create({
      data: {
        environmentId: env.id,
        provider: minted.ref.provider,
        kind: minted.kind,
        username: minted.username,
        secret: encrypt(minted.secret),
        repoUrl: minted.repoUrl,
        providerRef: minted.ref as unknown as Prisma.InputJsonValue,
      },
    })
  } catch (err) {
    // A concurrent request minted one first — keep theirs, revoke ours.
    await revokeScopedCredential(config, minted.ref).catch(() => {})
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.environmentGitCredential.findUnique({ where: { environmentId: env.id } })
      if (winner) {
        return { kind: winner.kind as CredentialKind, username: winner.username, secret: decrypt(winner.secret), repoUrl: winner.repoUrl, orgTokenFallback: false }
      }
    }
    throw err
  }

  return { kind: minted.kind, username: minted.username, secret: minted.secret, repoUrl: minted.repoUrl, orgTokenFallback: false }
}

function sameProvider(stored: string, config: GitProviderConfig): boolean {
  const current = config.type === 'gitea-bundled' ? 'gitea' : config.type
  return stored === current
}

/**
 * Revoke this environment's credential at the provider and delete the row.
 * The row is deleted first so the next fetch mints a fresh credential even if
 * the provider call fails (the failure is logged for manual cleanup).
 */
export async function revokeEnvironmentGitCredential(environmentId: string, config?: GitProviderConfig | null): Promise<void> {
  const row = await prisma.environmentGitCredential.findUnique({ where: { environmentId } })
  if (!row) return
  await prisma.environmentGitCredential.deleteMany({ where: { id: row.id } })

  const cfg = config ?? await getGitProviderConfig()
  if (!cfg) {
    console.warn(`[git-cred] git provider not configured — could not revoke ${row.provider} credential for environment ${environmentId}; remove it manually`)
    return
  }
  try {
    await revokeScopedCredential(cfg, row.providerRef as unknown as ProviderRef)
  } catch (err) {
    console.error(`[git-cred] failed to revoke ${row.provider} credential for environment ${environmentId} (remove it manually): ${err instanceof Error ? err.message : err}`)
  }
}
