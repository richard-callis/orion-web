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
    const upsertActions = await Promise.all(
      opts.files.map(async (f) => {
        const exists = await this.fileExists(opts.owner, opts.repo, f.path, opts.branch)
        return {
          action: exists ? 'update' : 'create',
          file_path: f.path,
          content: f.content,
          encoding: 'text',
        }
      }),
    )

    const deleteActions = (opts.deletions ?? []).map(path => ({
      action: 'delete',
      file_path: path,
    }))

    await this.fetch(`/projects/${this.projectPath(opts.owner, opts.repo)}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch: opts.branch,
        commit_message: opts.message,
        actions: [...upsertActions, ...deleteActions],
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

  // ── File reading (Nebula) ──────────────────────────────────────────────────

  async readFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const url = `${this.url}/api/v4/projects/${this.projectPath(owner, repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`
    const res = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': this.token },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`GitLab GET raw ${path} → ${res.status}: ${detail}`)
    }
    return res.text()
  }

  async listFiles(owner: string, repo: string, path: string, ref: string): Promise<string[]> {
    const items = await this.fetch<Array<{ name: string; type: string; path: string }>>(
      `/projects/${this.projectPath(owner, repo)}/repository/tree?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&recursive=false`,
    )
    return (items ?? [])
      .filter(f => f.type === 'blob' && f.name.endsWith('.yaml'))
      .map(f => f.path)
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

  async listOpenPRs(owner: string, repo: string): Promise<import('./index').GitPR[]> {
    const mrs = await this.fetch<GLMR[]>(
      `/projects/${this.projectPath(owner, repo)}/merge_requests?state=opened&per_page=50`,
    )
    return (mrs ?? []).map(toGitPR)
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
    if (!secret) return false // fail closed — unsigned webhooks on a public endpoint are not trusted
    const token = headers['x-gitlab-token'] ?? ''
    // MINOR fix: timingSafeEqual throws when buffers have different lengths, which
    // creates a timing/exception side-channel on token length. Pre-pad to equal length.
    const tokenBuf  = Buffer.from(token)
    const secretBuf = Buffer.from(secret)
    const maxLen    = Math.max(tokenBuf.length, secretBuf.length)
    const a = Buffer.alloc(maxLen)
    const b = Buffer.alloc(maxLen)
    tokenBuf.copy(a)
    secretBuf.copy(b)
    return timingSafeEqual(a, b) && tokenBuf.length === secretBuf.length
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
