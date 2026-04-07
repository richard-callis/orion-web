/**
 * Gitea REST API client
 *
 * Covers the operations ORION needs for the AI GitOps loop:
 *   - Repo management (create, check existence)
 *   - Branch management (create, delete)
 *   - File operations (create, update, get)
 *   - Pull requests (open, merge, get status)
 *   - Webhooks (register ORION callback on repo)
 *
 * Credentials come from env vars GITEA_URL + GITEA_ADMIN_TOKEN.
 * These are set in docker-compose.yml and stored in Vault post-wizard.
 */

const GITEA_URL = (process.env.GITEA_URL ?? 'http://gitea:3000').replace(/\/$/, '')
const GITEA_TOKEN = process.env.GITEA_ADMIN_TOKEN ?? ''

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GiteaRepo {
  id: number
  name: string
  full_name: string
  default_branch: string
  html_url: string
  clone_url: string
  ssh_url: string
  empty: boolean
}

export interface GiteaBranch {
  name: string
  commit: { id: string; message: string }
}

export interface GiteaFile {
  content: string  // base64-encoded
  sha: string
  name: string
  path: string
}

export interface GiteaPR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  html_url: string
  head: { label: string; ref: string; sha: string }
  base: { label: string; ref: string }
  labels: { name: string }[]
}

export interface CreateRepoOptions {
  owner: string        // Gitea username or org name
  name: string
  description?: string
  private?: boolean
  defaultBranch?: string
  isOrg?: boolean
}

export interface CommitFileOptions {
  owner: string
  repo: string
  branch: string
  path: string
  content: string      // plain text — will be base64-encoded
  message: string
  /** Required for updates; omit for new files */
  sha?: string
}

export interface CreatePROptions {
  owner: string
  repo: string
  title: string
  body: string
  head: string         // source branch
  base: string         // target branch (usually 'main')
  labels?: string[]
}

export interface MergePROptions {
  owner: string
  repo: string
  index: number
  message?: string
  /** 'merge' | 'rebase' | 'squash' — default 'merge' */
  style?: 'merge' | 'rebase' | 'squash'
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function giteaFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${GITEA_URL}/api/v1${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `token ${GITEA_TOKEN}`,
      ...options.headers,
    },
  })

  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { /* ignore */ }
    throw new GiteaError(res.status, `${options.method ?? 'GET'} ${url} → ${res.status}: ${detail}`)
  }

  // 204 No Content (e.g. branch delete)
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

export class GiteaError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'GiteaError'
  }
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function b64decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}

// ── Repo operations ───────────────────────────────────────────────────────────

export async function getRepo(owner: string, repo: string): Promise<GiteaRepo | null> {
  try {
    return await giteaFetch<GiteaRepo>(`/repos/${owner}/${repo}`)
  } catch (err) {
    if (err instanceof GiteaError && err.status === 404) return null
    throw err
  }
}

export async function createRepo(opts: CreateRepoOptions): Promise<GiteaRepo> {
  const body = {
    name: opts.name,
    description: opts.description ?? '',
    private: opts.private ?? true,
    auto_init: true,
    default_branch: opts.defaultBranch ?? 'main',
  }

  const path = opts.isOrg
    ? `/orgs/${opts.owner}/repos`
    : `/user/repos`

  return giteaFetch<GiteaRepo>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Creates a repo if it doesn't exist, otherwise returns the existing one. */
export async function ensureRepo(opts: CreateRepoOptions): Promise<GiteaRepo> {
  const existing = await getRepo(opts.owner, opts.name)
  if (existing) return existing
  return createRepo(opts)
}

// ── Branch operations ─────────────────────────────────────────────────────────

export async function getBranch(owner: string, repo: string, branch: string): Promise<GiteaBranch | null> {
  try {
    return await giteaFetch<GiteaBranch>(`/repos/${owner}/${repo}/branches/${branch}`)
  } catch (err) {
    if (err instanceof GiteaError && err.status === 404) return null
    throw err
  }
}

export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromBranch = 'main',
): Promise<GiteaBranch> {
  return giteaFetch<GiteaBranch>(`/repos/${owner}/${repo}/branches`, {
    method: 'POST',
    body: JSON.stringify({ new_branch_name: branch, old_branch_name: fromBranch }),
  })
}

export async function deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
  await giteaFetch<void>(`/repos/${owner}/${repo}/branches/${branch}`, {
    method: 'DELETE',
  })
}

// ── File operations ───────────────────────────────────────────────────────────

export async function getFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<GiteaFile | null> {
  try {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
    return await giteaFetch<GiteaFile>(`/repos/${owner}/${repo}/contents/${path}${query}`)
  } catch (err) {
    if (err instanceof GiteaError && err.status === 404) return null
    throw err
  }
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string | null> {
  const file = await getFile(owner, repo, path, ref)
  if (!file) return null
  return b64decode(file.content)
}

/**
 * Create or update a file on a branch.
 * Automatically fetches the current SHA when updating an existing file.
 */
export async function commitFile(opts: CommitFileOptions): Promise<void> {
  let sha = opts.sha
  if (!sha) {
    const existing = await getFile(opts.owner, opts.repo, opts.path, opts.branch)
    sha = existing?.sha
  }

  const body: Record<string, unknown> = {
    message: opts.message,
    content: b64encode(opts.content),
    branch: opts.branch,
  }
  if (sha) body.sha = sha

  const method = sha ? 'PUT' : 'POST'
  await giteaFetch(`/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`, {
    method,
    body: JSON.stringify(body),
  })
}

/**
 * Commit multiple files to a branch in a single API call.
 * Uses Gitea's Git Trees API to avoid N+1 round-trips.
 */
export async function commitFiles(opts: {
  owner: string
  repo: string
  branch: string
  files: Array<{ path: string; content: string }>
  message: string
}): Promise<void> {
  // 1. Get current branch HEAD SHA
  const branch = await giteaFetch<GiteaBranch>(
    `/repos/${opts.owner}/${opts.repo}/branches/${opts.branch}`,
  )
  const headSha = branch.commit.id

  // 2. Get the base tree SHA
  const commit = await giteaFetch<{ tree: { sha: string } }>(
    `/repos/${opts.owner}/${opts.repo}/git/commits/${headSha}`,
  )

  // 3. Create blobs for each file
  const treeItems = await Promise.all(
    opts.files.map(async (f) => {
      const blob = await giteaFetch<{ sha: string }>(
        `/repos/${opts.owner}/${opts.repo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({ content: b64encode(f.content), encoding: 'base64' }),
        },
      )
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha }
    }),
  )

  // 4. Create tree
  const tree = await giteaFetch<{ sha: string }>(
    `/repos/${opts.owner}/${opts.repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({ base_tree: commit.tree.sha, tree: treeItems }),
    },
  )

  // 5. Create commit
  const newCommit = await giteaFetch<{ sha: string }>(
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

  // 6. Update branch ref
  await giteaFetch(`/repos/${opts.owner}/${opts.repo}/git/refs/heads/${opts.branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  })
}

// ── Pull request operations ───────────────────────────────────────────────────

export async function createPR(opts: CreatePROptions): Promise<GiteaPR> {
  const body: Record<string, unknown> = {
    title: opts.title,
    body: opts.body,
    head: opts.head,
    base: opts.base,
  }
  if (opts.labels?.length) body.labels = opts.labels

  return giteaFetch<GiteaPR>(`/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getPR(owner: string, repo: string, index: number): Promise<GiteaPR> {
  return giteaFetch<GiteaPR>(`/repos/${owner}/${repo}/pulls/${index}`)
}

export async function listOpenPRs(owner: string, repo: string): Promise<GiteaPR[]> {
  return giteaFetch<GiteaPR[]>(`/repos/${owner}/${repo}/pulls?state=open&limit=50`)
}

export async function mergePR(opts: MergePROptions): Promise<void> {
  await giteaFetch<void>(`/repos/${opts.owner}/${opts.repo}/pulls/${opts.index}/merge`, {
    method: 'POST',
    body: JSON.stringify({
      Do: opts.style ?? 'merge',
      merge_message_field: opts.message ?? '',
    }),
  })
}

/** Create a PR and immediately merge it (auto-merge flow). */
export async function createAndMergePR(opts: CreatePROptions & { mergeMessage?: string }): Promise<GiteaPR> {
  const pr = await createPR(opts)
  await mergePR({
    owner: opts.owner,
    repo: opts.repo,
    index: pr.number,
    message: opts.mergeMessage,
  })
  return pr
}

// ── Webhook operations ────────────────────────────────────────────────────────

export async function ensureWebhook(
  owner: string,
  repo: string,
  callbackUrl: string,
  secret: string,
): Promise<void> {
  const hooks = await giteaFetch<Array<{ id: number; config: { url: string } }>>(
    `/repos/${owner}/${repo}/hooks`,
  )
  const existing = hooks.find(h => h.config.url === callbackUrl)
  if (existing) return

  await giteaFetch(`/repos/${owner}/${repo}/hooks`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'gitea',
      active: true,
      events: ['push', 'pull_request'],
      config: {
        url: callbackUrl,
        content_type: 'json',
        secret,
      },
    }),
  })
}

// ── Org / user helpers ────────────────────────────────────────────────────────

export async function ensureOrg(orgName: string): Promise<void> {
  try {
    await giteaFetch(`/orgs/${orgName}`)
    return // already exists
  } catch (err) {
    if (!(err instanceof GiteaError) || err.status !== 404) throw err
  }

  await giteaFetch('/orgs', {
    method: 'POST',
    body: JSON.stringify({
      username: orgName,
      visibility: 'private',
    }),
  })
}

// ── Health check ──────────────────────────────────────────────────────────────

export async function giteaHealthy(): Promise<boolean> {
  try {
    await giteaFetch('/settings/api')
    return true
  } catch {
    return false
  }
}
