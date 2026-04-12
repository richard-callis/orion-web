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
    // Check if it exists
    try {
      const existing = await this.fetch<GiteaRepo>(`/repos/${opts.owner}/${opts.name}`)
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
    const created = await this.fetch<GiteaRepo>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return toGitRepo(created)
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
    // Use Git Trees API for atomic multi-file commit
    const branch = await this.fetch<{ commit: { id: string } }>(
      `/repos/${opts.owner}/${opts.repo}/branches/${opts.branch}`,
    )
    const headSha = branch.commit.id

    const commit = await this.fetch<{ tree: { sha: string } }>(
      `/repos/${opts.owner}/${opts.repo}/git/commits/${headSha}`,
    )

    const treeItems = await Promise.all(
      opts.files.map(async (f) => {
        const blob = await this.fetch<{ sha: string }>(
          `/repos/${opts.owner}/${opts.repo}/git/blobs`,
          {
            method: 'POST',
            body: JSON.stringify({
              content: Buffer.from(f.content, 'utf8').toString('base64'),
              encoding: 'base64',
            }),
          },
        )
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha }
      }),
    )

    const tree = await this.fetch<{ sha: string }>(
      `/repos/${opts.owner}/${opts.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: commit.tree.sha, tree: treeItems }),
      },
    )

    const newCommit = await this.fetch<{ sha: string }>(
      `/repos/${opts.owner}/${opts.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: opts.message,
          tree: tree.sha,
          parents: [headSha],
        }),
      },
    )

    await this.fetch(`/repos/${opts.owner}/${opts.repo}/git/refs/heads/${opts.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    })
  }

  // ── PRs ────────────────────────────────────────────────────────────────────

  async createPR(opts: CreatePROptions): Promise<GitPR> {
    const body: Record<string, unknown> = {
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    }
    if (opts.labels?.length) body.labels = opts.labels

    const pr = await this.fetch<GiteaPR>(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
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
