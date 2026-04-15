/**
 * GitLab Git Provider
 *
 * Uses the GitLab REST API v4.
 * Works with gitlab.com and self-hosted instances.
 *
 * Key differences from GitHub/Gitea:
 *   - "repositories" are called "projects", identified by namespace/path
 *   - "pull requests" are called "merge requests"
 *   - Webhook verification uses X-Gitlab-Token (plain secret, no HMAC)
 *   - Atomic multi-file commits via POST /projects/:id/repository/commits
 */

import { timingSafeEqual } from 'crypto'
import type {
  GitProvider,
  GitRepo,
  GitPR,
  EnsureRepoOptions,
  CommitFilesOptions,
  CreatePROptions,
} from './index'

interface GitLabProviderOptions {
  url: string
  token: string
  webhookSecret?: string
}

export class GitLabGitProvider implements GitProvider {
  readonly type = 'gitlab' as const
  private readonly url: string
  private readonly token: string
  private readonly webhookSecret?: string

  constructor(opts: GitLabProviderOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.token = opts.token
    this.webhookSecret = opts.webhookSecret
  }

  // ── Internal fetch helper ──────────────────────────────────────────────────

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.url}/api/v4${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': this.token,
        ...init.headers,
      },
    })
    if (res.status === 204) return undefined as T
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`GitLab ${init.method ?? 'GET'} ${path} → ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T>
  }

  /** Encode "owner/repo" as GitLab namespace path for API use */
  private projectPath(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`)
  }

  // ── Repos (GitLab: "projects") ─────────────────────────────────────────────

  async ensureRepo(opts: EnsureRepoOptions): Promise<GitRepo> {
    try {
      const existing = await this.fetch<GLProject>(
        `/projects/${this.projectPath(opts.owner, opts.name)}`,
      )
      return toGitRepo(existing)
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err
    }

    const body: Record<string, unknown> = {
      name: opts.name,
      description: opts.description ?? '',
      visibility: (opts.private ?? true) ? 'private' : 'public',
      initialize_with_readme: true,
      default_branch: opts.defaultBranch ?? 'main',
    }
    if (opts.isOrg) body.namespace_id = await this.getNamespaceId(opts.owner)

    const created = await this.fetch<GLProject>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return toGitRepo(created)
  }

  private async getNamespaceId(name: string): Promise<number> {
    const ns = await this.fetch<{ id: number }>(`/namespaces/${encodeURIComponent(name)}`)
    return ns.id
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  async createBranch(owner: string, repo: string, branch: string, from = 'main'): Promise<void> {
    await this.fetch(`/projects/${this.projectPath(owner, repo)}/repository/branches`, {
      method: 'POST',
      body: JSON.stringify({ branch, ref: from }),
    })
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.fetch(
      `/projects/${this.projectPath(owner, repo)}/repository/branches/${encodeURIComponent(branch)}`,
      { method: 'DELETE' },
    )
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async commitFiles(opts: CommitFilesOptions): Promise<void> {
    // GitLab's commits API supports multiple file actions in one request
    const actions = await Promise.all(
      opts.files.map(async (f) => {
        // Determine if file exists to decide create vs update
        const exists = await this.fileExists(opts.owner, opts.repo, f.path, opts.branch)
        return {
          action: exists ? 'update' : 'create',
          file_path: f.path,
          content: f.content,
          encoding: 'text',
        }
      }),
    )

    await this.fetch(`/projects/${this.projectPath(opts.owner, opts.repo)}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch: opts.branch,
        commit_message: opts.message,
        actions,
      }),
    })
  }

  private async fileExists(owner: string, repo: string, path: string, ref: string): Promise<boolean> {
    try {
      await this.fetch(
        `/projects/${this.projectPath(owner, repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      )
      return true
    } catch {
      return false
    }
  }

  // ── PRs (GitLab: "merge requests") ─────────────────────────────────────────

  async createPR(opts: CreatePROptions): Promise<GitPR> {
    const body: Record<string, unknown> = {
      title: opts.title,
      description: opts.body,
      source_branch: opts.head,
      target_branch: opts.base,
      remove_source_branch: false,
    }
    if (opts.labels?.length) body.labels = opts.labels.join(',')

    const mr = await this.fetch<GLMR>(
      `/projects/${this.projectPath(opts.owner, opts.repo)}/merge_requests`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return toGitPR(mr)
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<import('./index').GitPR> {
    const mr = await this.fetch<GLMR>(`/projects/${this.projectPath(owner, repo)}/merge_requests/${prNumber}`)
    return toGitPR(mr)
  }

  async mergePR(owner: string, repo: string, prNumber: number, message?: string): Promise<void> {
    await this.fetch(
      `/projects/${this.projectPath(owner, repo)}/merge_requests/${prNumber}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ merge_commit_message: message ?? '' }),
      },
    )
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  async ensureWebhook(owner: string, repo: string, callbackUrl: string, secret: string): Promise<void> {
    const hooks = await this.fetch<Array<{ id: number; url: string }>>(
      `/projects/${this.projectPath(owner, repo)}/hooks`,
    )
    if (hooks.find(h => h.url === callbackUrl)) return

    await this.fetch(`/projects/${this.projectPath(owner, repo)}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: callbackUrl,
        token: secret,
        push_events: true,
        merge_requests_events: true,
      }),
    })
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  getPRUrl(owner: string, repo: string, prNumber: number): string {
    return `${this.url}/${owner}/${repo}/-/merge_requests/${prNumber}`
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    // GitLab uses plain token comparison (not HMAC)
    if (!secret) return true
    const token = headers['x-gitlab-token'] ?? ''
    try {
      return timingSafeEqual(Buffer.from(token), Buffer.from(secret))
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

// ── Internal GitLab types ──────────────────────────────────────────────────

interface GLProject {
  name: string
  path_with_namespace: string
  http_url_to_repo: string
  default_branch: string
  web_url: string
}

interface GLMR {
  iid: number
  title: string
  description: string
  state: 'opened' | 'closed' | 'merged'
  web_url: string
  source_branch: string
  target_branch: string
  merged_at?: string
}

function toGitRepo(p: GLProject): GitRepo {
  return {
    name: p.name,
    fullName: p.path_with_namespace,
    cloneUrl: p.http_url_to_repo,
    defaultBranch: p.default_branch,
    htmlUrl: p.web_url,
  }
}

function toGitPR(mr: GLMR): GitPR {
  return {
    number: mr.iid,
    title: mr.title,
    body: mr.description,
    state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
    htmlUrl: mr.web_url,
    headBranch: mr.source_branch,
    baseBranch: mr.target_branch,
    merged: mr.state === 'merged',
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('404')
}
