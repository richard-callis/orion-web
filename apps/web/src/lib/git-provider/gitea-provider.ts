/**
 * Gitea Git Provider
 *
 * Adapts the existing gitea.ts low-level client to the GitProvider interface.
 * Used for both bundled Gitea (type=gitea-bundled) and external Gitea instances.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type {
  GitProvider,
  GitRepo,
  GitPR,
  EnsureRepoOptions,
  CommitFilesOptions,
  CreatePROptions,
} from './index'

interface GiteaProviderOptions {
  url: string
  token: string
  webhookSecret?: string
}

export class GiteaGitProvider implements GitProvider {
  readonly type = 'gitea' as const
  private readonly url: string
  private readonly token: string
  private readonly webhookSecret?: string

  constructor(opts: GiteaProviderOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.token = opts.token
    this.webhookSecret = opts.webhookSecret
  }

  // ── Internal fetch helper ──────────────────────────────────────────────────

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.url}/api/v1${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${this.token}`,
        ...init.headers,
      },
    })
    if (res.status === 204) return undefined as T
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`Gitea ${init.method ?? 'GET'} ${path} → ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T>
  }

  // ── Repos ──────────────────────────────────────────────────────────────────

  async ensureRepo(opts: EnsureRepoOptions): Promise<GitRepo> {
    // Determine actual owner: for user repos, use the authenticated user's login
    let resolvedOwner = opts.owner
    if (!opts.isOrg) {
      const authedUser = await this.fetch<{ login: string }>('/user')
      resolvedOwner = authedUser.login
    }

    // Check if it exists
    try {
      const existing = await this.fetch<GiteaRepo>(`/repos/${resolvedOwner}/${opts.name}`)
      return toGitRepo(existing)
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err
    }

    const body = {
      name: opts.name,
      description: opts.description ?? '',
      private: opts.private ?? true,
      auto_init: true,
      default_branch: opts.defaultBranch ?? 'main',
    }
    const path = opts.isOrg ? `/orgs/${opts.owner}/repos` : `/user/repos`
    try {
      const created = await this.fetch<GiteaRepo>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return toGitRepo(created)
    } catch (err: unknown) {
      // 409 = repo already exists under the authenticated user — fetch and return it
      if (err instanceof Error && err.message.includes('409')) {
        // Determine the actual owner: org repos use opts.owner, user repos use the authed user
        const authedUser = await this.fetch<{ login: string }>('/user')
        const actualOwner = opts.isOrg ? opts.owner : authedUser.login
        const existing = await this.fetch<GiteaRepo>(`/repos/${actualOwner}/${opts.name}`)
        return toGitRepo(existing)
      }
      throw err
    }
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  async createBranch(owner: string, repo: string, branch: string, from = 'main'): Promise<void> {
    await this.fetch(`/repos/${owner}/${repo}/branches`, {
      method: 'POST',
      body: JSON.stringify({ new_branch_name: branch, old_branch_name: from }),
    })
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.fetch(`/repos/${owner}/${repo}/branches/${branch}`, { method: 'DELETE' })
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async commitFiles(opts: CommitFilesOptions): Promise<void> {
    // Use Contents API (PUT/POST per file) — supported by all Gitea versions.
    // Files are committed sequentially on the target branch.
    for (const f of opts.files) {
      const encodedPath = f.path.split('/').map(encodeURIComponent).join('/')
      const contentB64 = Buffer.from(f.content, 'utf8').toString('base64')

      // Check if the file already exists so we can supply its SHA for updates
      let existingSha: string | undefined
      try {
        const existing = await this.fetch<{ sha: string }>(
          `/repos/${opts.owner}/${opts.repo}/contents/${encodedPath}?ref=${encodeURIComponent(opts.branch)}`,
        )
        existingSha = existing.sha
      } catch (err: unknown) {
        if (!isNotFound(err)) throw err
        // File does not exist yet — will be created
      }

      const body: Record<string, unknown> = {
        message: opts.message,
        content: contentB64,
        branch: opts.branch,
      }
      if (existingSha) body.sha = existingSha

      await this.fetch(`/repos/${opts.owner}/${opts.repo}/contents/${encodedPath}`, {
        method: existingSha ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
    }
  }

  // ── PRs ────────────────────────────────────────────────────────────────────

  async createPR(opts: CreatePROptions): Promise<GitPR> {
    const body: Record<string, unknown> = {
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    }
    // Gitea labels API expects integer IDs, not strings — skip to avoid 422

    const pr = await this.fetch<GiteaPR>(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return toGitPR(pr)
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<GitPR> {
    const pr = await this.fetch<GiteaPR>(`/repos/${owner}/${repo}/pulls/${prNumber}`)
    return toGitPR(pr)
  }

  async mergePR(owner: string, repo: string, prNumber: number, message?: string): Promise<void> {
    await this.fetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'POST',
      body: JSON.stringify({ Do: 'merge', merge_message_field: message ?? '' }),
    })
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  async ensureWebhook(owner: string, repo: string, callbackUrl: string, secret: string): Promise<void> {
    const hooks = await this.fetch<Array<{ id: number; config: { url: string } }>>(
      `/repos/${owner}/${repo}/hooks`,
    )
    if (hooks.find(h => h.config.url === callbackUrl)) return

    await this.fetch(`/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'gitea',
        active: true,
        events: ['push', 'pull_request'],
        config: { url: callbackUrl, content_type: 'json', secret },
      }),
    })
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  getPRUrl(owner: string, repo: string, prNumber: number): string {
    return `${this.url}/${owner}/${repo}/pulls/${prNumber}`
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    const signature = headers['x-gitea-signature'] ?? ''
    if (!secret) return true
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    try {
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.fetch('/settings/api')
      return true
    } catch {
      return false
    }
  }

  // ── Org management (Gitea-specific, used by bootstrap) ────────────────────

  async ensureOrg(orgName: string): Promise<void> {
    try {
      await this.fetch(`/orgs/${orgName}`)
      return
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err
    }
    await this.fetch('/orgs', {
      method: 'POST',
      body: JSON.stringify({ username: orgName, visibility: 'private' }),
    })
  }

  /**
   * Bootstrap Gitea admin: creates an admin token via basic auth.
   * Used by the setup wizard when deploying bundled Gitea.
   */
  async createAdminToken(username: string, password: string, tokenName: string): Promise<string> {
    const credentials = Buffer.from(`${username}:${password}`).toString('base64')
    const res = await fetch(`${this.url}/api/v1/users/${username}/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ name: tokenName }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Failed to create Gitea token: ${res.status} ${detail}`)
    }
    const data = await res.json() as { sha1: string }
    return data.sha1
  }
}

// ── Internal Gitea types ───────────────────────────────────────────────────

interface GiteaRepo {
  name: string
  full_name: string
  clone_url: string
  default_branch: string
  html_url: string
}

interface GiteaPR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  html_url: string
  head: { ref: string }
  base: { ref: string }
}

function toGitRepo(r: GiteaRepo): GitRepo {
  return {
    name: r.name,
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
  }
}

function toGitPR(p: GiteaPR): GitPR {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.merged ? 'merged' : p.state,
    htmlUrl: p.html_url,
    headBranch: p.head.ref,
    baseBranch: p.base.ref,
    merged: p.merged,
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('404')
}
