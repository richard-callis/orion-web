/**
 * Git Provider Abstraction
 *
 * All GitOps operations go through this interface — the underlying provider
 * (Gitea, GitHub, GitLab) is swapped transparently.
 *
 * Configuration is stored in SystemSetting key 'git.provider.config'.
 * Falls back to GITEA_URL / GITEA_ADMIN_TOKEN env vars for backwards compat.
 */

import { prisma } from '@/lib/db'
import { GiteaGitProvider } from './gitea-provider'
import { GitHubGitProvider } from './github-provider'
import { GitLabGitProvider } from './gitlab-provider'

// ── Shared types ──────────────────────────────────────────────────────────────

export interface GitRepo {
  name: string
  fullName: string   // "owner/repo"
  cloneUrl: string
  defaultBranch: string
  htmlUrl: string
}

export interface GitPR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  htmlUrl: string
  headBranch: string
  baseBranch: string
  merged: boolean
}

export interface EnsureRepoOptions {
  owner: string       // org or user
  name: string
  description?: string
  private?: boolean
  defaultBranch?: string
  isOrg?: boolean
}

export interface CommitFilesOptions {
  owner: string
  repo: string
  branch: string
  files: Array<{ path: string; content: string }>
  message: string
}

export interface CreatePROptions {
  owner: string
  repo: string
  title: string
  body: string
  head: string        // source branch
  base: string        // target branch
  labels?: string[]
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface GitProvider {
  readonly type: GitProviderType

  // Repos
  ensureRepo(opts: EnsureRepoOptions): Promise<GitRepo>

  // Branches
  createBranch(owner: string, repo: string, branch: string, from?: string): Promise<void>
  deleteBranch(owner: string, repo: string, branch: string): Promise<void>

  // Files
  commitFiles(opts: CommitFilesOptions): Promise<void>

  // PRs
  createPR(opts: CreatePROptions): Promise<GitPR>
  mergePR(owner: string, repo: string, prNumber: number, message?: string): Promise<void>

  // Webhooks
  ensureWebhook(owner: string, repo: string, callbackUrl: string, secret: string): Promise<void>

  // Utilities
  getPRUrl(owner: string, repo: string, prNumber: number): string
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean

  // Health
  isHealthy(): Promise<boolean>
}

// ── Provider config (stored in SystemSetting 'git.provider.config') ──────────

export type GitProviderType = 'gitea-bundled' | 'gitea' | 'github' | 'gitlab'

export interface GitProviderConfig {
  type: GitProviderType
  /** API base URL — omit for gitea-bundled (uses http://gitea:3000) and github (uses api.github.com) */
  url?: string
  /** API token / PAT */
  token: string
  /** Default org or user namespace for repo operations */
  org: string
  /** HMAC secret for incoming webhook signature verification */
  webhookSecret?: string
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createProvider(config: GitProviderConfig): GitProvider {
  switch (config.type) {
    case 'gitea-bundled':
      return new GiteaGitProvider({
        url: 'http://gitea:3000',
        token: config.token,
        webhookSecret: config.webhookSecret,
      })
    case 'gitea':
      return new GiteaGitProvider({
        url: config.url ?? 'http://gitea:3000',
        token: config.token,
        webhookSecret: config.webhookSecret,
      })
    case 'github':
      return new GitHubGitProvider({
        token: config.token,
        webhookSecret: config.webhookSecret,
      })
    case 'gitlab':
      return new GitLabGitProvider({
        url: config.url ?? 'https://gitlab.com',
        token: config.token,
        webhookSecret: config.webhookSecret,
      })
    default:
      throw new Error(`Unknown git provider type: ${(config as { type: string }).type}`)
  }
}

// ── Singleton loader ──────────────────────────────────────────────────────────

let _cached: GitProvider | null = null

/**
 * Returns the configured git provider.
 * Reads SystemSetting 'git.provider.config', falls back to env vars.
 * Cached per process — call invalidateGitProviderCache() after wizard setup.
 */
export async function getGitProvider(): Promise<GitProvider> {
  if (_cached) return _cached

  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'git.provider.config' },
  })

  if (setting) {
    _cached = createProvider(setting.value as unknown as GitProviderConfig)
    return _cached
  }

  // Backwards-compat fallback: env vars
  _cached = new GiteaGitProvider({
    url: process.env.GITEA_URL ?? 'http://gitea:3000',
    token: process.env.GITEA_ADMIN_TOKEN ?? '',
    webhookSecret: process.env.GITEA_WEBHOOK_SECRET,
  })
  return _cached
}

export function invalidateGitProviderCache(): void {
  _cached = null
}
