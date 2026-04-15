/**
 * GitHub Git Provider
 *
 * Uses the GitHub REST API v3 (no Octokit dependency — plain fetch).
 * Webhook verification uses X-Hub-Signature-256 (sha256=<hex>).
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

interface GitHubProviderOptions {
  token: string
  webhookSecret?: string
}

export class GitHubGitProvider implements GitProvider {
  readonly type = 'github' as const
  private readonly token: string
  private readonly webhookSecret?: string
  private readonly apiBase = 'https://api.github.com'

  constructor(opts: GitHubProviderOptions) {
    this.token = opts.token
    this.webhookSecret = opts.webhookSecret
  }

  // ── Internal fetch helper ──────────────────────────────────────────────────

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.apiBase}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    })
    if (res.status === 204) return undefined as T
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T>
  }

  // ── Repos ──────────────────────────────────────────────────────────────────

  async ensureRepo(opts: EnsureRepoOptions): Promise<GitRepo> {
    try {
      const existing = await this.fetch<GHRepo>(`/repos/${opts.owner}/${opts.name}`)
      return toGitRepo(existing)
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err
    }

    const body = {
      name: opts.name,
      description: opts.description ?? '',
      private: opts.private ?? true,
      auto_init: true,
    }
    const path = opts.isOrg ? `/orgs/${opts.owner}/repos` : '/user/repos'
    const created = await this.fetch<GHRepo>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return toGitRepo(created)
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  async createBranch(owner: string, repo: string, branch: string, from = 'main'): Promise<void> {
    // Get the SHA of the base branch
    const ref = await this.fetch<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${from}`,
    )
    await this.fetch(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
    })
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.fetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: 'DELETE' })
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async commitFiles(opts: CommitFilesOptions): Promise<void> {
    // GitHub Trees API for atomic multi-file commit
    const refData = await this.fetch<{ object: { sha: string } }>(
      `/repos/${opts.owner}/${opts.repo}/git/ref/heads/${opts.branch}`,
    )
    const headSha = refData.object.sha

    const commitData = await this.fetch<{ tree: { sha: string } }>(
      `/repos/${opts.owner}/${opts.repo}/git/commits/${headSha}`,
    )
    const baseTreeSha = commitData.tree.sha

    // Create blobs
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
        return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha }
      }),
    )

    const tree = await this.fetch<{ sha: string }>(
      `/repos/${opts.owner}/${opts.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
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

    // Update branch ref
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
    const pr = await this.fetch<GHPR>(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    // Apply labels if provided (separate API call on GitHub)
    if (opts.labels?.length) {
      await this.fetch(`/repos/${opts.owner}/${opts.repo}/issues/${pr.number}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: opts.labels }),
      }).catch(() => { /* label creation failure is non-fatal */ })
    }

    return toGitPR(pr)
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<import('./index').GitPR> {
    const pr = await this.fetch<GHPR>(`/repos/${owner}/${repo}/pulls/${prNumber}`)
    return toGitPR(pr)
  }

  async mergePR(owner: string, repo: string, prNumber: number, message?: string): Promise<void> {
    await this.fetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        merge_method: 'merge',
        commit_message: message ?? '',
      }),
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
        name: 'web',
        active: true,
        events: ['push', 'pull_request'],
        config: { url: callbackUrl, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    })
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  getPRUrl(owner: string, repo: string, prNumber: number): string {
    return `https://github.com/${owner}/${repo}/pull/${prNumber}`
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    // GitHub sends: X-Hub-Signature-256: sha256=<hex>
    const header = headers['x-hub-signature-256'] ?? ''
    const signature = header.startsWith('sha256=') ? header.slice(7) : ''
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
      await this.fetch('/user')
      return true
    } catch {
      return false
    }
  }
}

// ── Internal GitHub types ──────────────────────────────────────────────────

interface GHRepo {
  name: string
  full_name: string
  clone_url: string
  default_branch: string
  html_url: string
}

interface GHPR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  html_url: string
  head: { ref: string }
  base: { ref: string }
}

function toGitRepo(r: GHRepo): GitRepo {
  return {
    name: r.name,
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
  }
}

function toGitPR(p: GHPR): GitPR {
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
