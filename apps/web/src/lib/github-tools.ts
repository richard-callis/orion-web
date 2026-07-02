/**
 * GitHub agent tools.
 *
 * These tools let task/chat agents interact with GitHub on behalf of the user who
 * owns the agent. The owning user is resolved server-side from the agent's
 * createdBy (we never trust a userId passed through MCP context). The user's
 * encrypted GitHub PAT is then looked up via getGithubTokenForUser.
 */

import { z } from 'zod'
import { registerTool, type ToolExecutionContext } from '@/lib/tool-registry'
import { getGithubTokenForUser, githubFetch, handleGithubError } from '@/lib/github'
import { prisma } from '@/lib/db'

const SAFE_OWNER_REPO = /^[A-Za-z0-9._-]+$/

function validateOwnerRepo(owner: string, repo: string): string | null {
  if (!SAFE_OWNER_REPO.test(owner)) return `Invalid owner: "${owner}"`
  if (!SAFE_OWNER_REPO.test(repo)) return `Invalid repo: "${repo}"`
  return null
}

// Check if a repo is in the user's allowlist (empty list = allow all)
async function assertRepoAllowed(userId: string, owner: string, repo: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubAllowedRepos: true },
  })
  const list = (user?.githubAllowedRepos ?? []).map(r => r.toLowerCase())
  if (list.length === 0) return null  // empty = allow all
  const slug = `${owner}/${repo}`.toLowerCase()
  if (list.includes(slug)) return null
  return `Repository "${owner}/${repo}" is not in your GitHub allowlist.`
}

// Resolve the user who owns this agent
async function resolveUserId(ctx: ToolExecutionContext): Promise<string | null> {
  if (!ctx.agentId) return null
  const agent = await prisma.agent.findUnique({
    where: { id: ctx.agentId },
    select: { createdBy: true },
  })
  return agent?.createdBy ?? null
}

async function getTokenForCtx(ctx: ToolExecutionContext): Promise<{ token: string } | { error: string }> {
  if (!ctx.agentId) return { error: 'GitHub tools require a user-owned agent' }
  const userId = await resolveUserId(ctx)
  if (!userId) return { error: 'GitHub tools require a user-owned agent' }
  const token = await getGithubTokenForUser(userId)
  if (!token) return { error: 'GitHub not connected. Ask the agent owner to connect their GitHub account at /settings/github.' }
  return { token }
}

// ── github_list_repos ──────────────────────────────────────────────────────

const listReposSchema = z.object({
  type: z.enum(['all', 'owner', 'member']).default('owner'),
  sort: z.enum(['created', 'updated', 'pushed', 'full_name']).default('updated'),
  per_page: z.number().int().min(1).max(100).default(30),
})

async function githubListRepos(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const parsed = listReposSchema.safeParse(args)
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`
  const tok = await getTokenForCtx(ctx)
  if ('error' in tok) return tok.error
  const { type, sort, per_page } = parsed.data
  const res = await githubFetch(tok.token, `/user/repos?type=${type}&sort=${sort}&per_page=${per_page}`)
  if (!res.ok) return handleGithubError(res)
  const repos = await res.json() as Array<{ full_name: string; description: string | null; default_branch: string; private: boolean }>
  return JSON.stringify(repos.map(r => ({ full_name: r.full_name, description: r.description, default_branch: r.default_branch, private: r.private })))
}

// ── github_get_file ────────────────────────────────────────────────────────

const getFileSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().optional(),
})

async function githubGetFile(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const parsed = getFileSchema.safeParse(args)
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`
  const tok = await getTokenForCtx(ctx)
  if ('error' in tok) return tok.error
  const { owner, repo, path, ref } = parsed.data
  const validationError = validateOwnerRepo(owner, repo)
  if (validationError) return validationError
  const userId = await resolveUserId(ctx)
  if (userId) {
    const allowErr = await assertRepoAllowed(userId, owner, repo)
    if (allowErr) return allowErr
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await githubFetch(tok.token, `/repos/${owner}/${repo}/contents/${encodedPath}${query}`)
  if (!res.ok) return handleGithubError(res)
  const data = await res.json() as { content: string; sha: string; encoding: string; size: number }
  const content = Buffer.from(data.content, 'base64').toString('utf8')
  return JSON.stringify({ content, sha: data.sha, size: data.size })
}

// ── github_create_or_update_file ───────────────────────────────────────────

const createOrUpdateFileSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  message: z.string().min(1),
  content: z.string(),  // plain text — will be base64-encoded
  branch: z.string().min(1),
  sha: z.string().optional(),  // current blob SHA if updating; omit to auto-fetch
})

async function githubCreateOrUpdateFile(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const parsed = createOrUpdateFileSchema.safeParse(args)
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`
  const tok = await getTokenForCtx(ctx)
  if ('error' in tok) return tok.error
  const { owner, repo, path, message, content, branch, sha: providedSha } = parsed.data
  const validationError = validateOwnerRepo(owner, repo)
  if (validationError) return validationError
  const userId = await resolveUserId(ctx)
  if (userId) {
    const allowErr = await assertRepoAllowed(userId, owner, repo)
    if (allowErr) return allowErr
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')

  let sha = providedSha
  if (!sha) {
    // Fetch existing file to get SHA (required for updates)
    const existing = await githubFetch(tok.token, `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`)
    if (existing.ok) {
      const data = await existing.json() as { sha: string }
      sha = data.sha
    } else if (existing.status !== 404) {
      return handleGithubError(existing)
    }
    // 404 = new file, sha stays undefined
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  }
  if (sha) body.sha = sha

  const res = await githubFetch(tok.token, `/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  if (!res.ok) return handleGithubError(res)
  const data = await res.json() as { commit: { sha: string }; content: { html_url: string } }
  return JSON.stringify({ commit_sha: data.commit.sha, html_url: data.content.html_url })
}

// ── github_create_branch ───────────────────────────────────────────────────

const createBranchSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  from_branch: z.string().default('main'),
})

async function githubCreateBranch(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const parsed = createBranchSchema.safeParse(args)
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`
  const tok = await getTokenForCtx(ctx)
  if ('error' in tok) return tok.error
  const { owner, repo, branch, from_branch } = parsed.data
  const validationError = validateOwnerRepo(owner, repo)
  if (validationError) return validationError
  const userId = await resolveUserId(ctx)
  if (userId) {
    const allowErr = await assertRepoAllowed(userId, owner, repo)
    if (allowErr) return allowErr
  }

  // Get the SHA of the source branch
  const refRes = await githubFetch(tok.token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`)
  if (!refRes.ok) return `Source branch not found: ${from_branch} (${refRes.status})`
  const refData = await refRes.json() as { object: { sha: string } }
  const sha = refData.object.sha

  const res = await githubFetch(tok.token, `/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  })
  if (res.status === 422) return `Branch already exists: ${branch}`
  if (!res.ok) return handleGithubError(res)
  const data = await res.json() as { ref: string; object: { sha: string } }
  return JSON.stringify({ ref: data.ref, sha: data.object.sha })
}

// ── github_create_pull_request ─────────────────────────────────────────────

const createPullRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(''),
  head: z.string().min(1),
  base: z.string().min(1),
  draft: z.boolean().default(false),
})

async function githubCreatePullRequest(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const parsed = createPullRequestSchema.safeParse(args)
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`
  const tok = await getTokenForCtx(ctx)
  if ('error' in tok) return tok.error
  const { owner, repo, title, body, head, base, draft } = parsed.data
  const validationError = validateOwnerRepo(owner, repo)
  if (validationError) return validationError
  const userId = await resolveUserId(ctx)
  if (userId) {
    const allowErr = await assertRepoAllowed(userId, owner, repo)
    if (allowErr) return allowErr
  }

  const res = await githubFetch(tok.token, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, body, head, base, draft }),
  })
  if (!res.ok) return handleGithubError(res)
  const data = await res.json() as { number: number; html_url: string; state: string }
  return JSON.stringify({ number: data.number, html_url: data.html_url, state: data.state })
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerGithubTools(): void {
  registerTool({
    name: 'github_list_repos',
    description: 'List GitHub repositories accessible with the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['all', 'owner', 'member'], description: 'Filter repositories by type' },
        sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'] },
        per_page: { type: 'number', description: 'Results per page (max 100)' },
      },
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'github',
    handler: githubListRepos,
  })

  registerTool({
    name: 'github_get_file',
    description: 'Get file contents from a GitHub repository. Returns content (decoded), sha, and size. The sha is required when updating the file.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string', description: 'File path within the repository' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: repo default branch)' },
      },
      required: ['owner', 'repo', 'path'],
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'github',
    handler: githubGetFile,
  })

  registerTool({
    name: 'github_create_or_update_file',
    description: 'Create or update a file in a GitHub repository. Provide content as plain text. If the file exists, fetches the current sha automatically (or pass sha explicitly to skip the extra request).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string', description: 'File path (e.g. "src/main.py")' },
        message: { type: 'string', description: 'Commit message' },
        content: { type: 'string', description: 'File content as plain text' },
        branch: { type: 'string', description: 'Branch to commit to' },
        sha: { type: 'string', description: 'Current blob SHA (optional — auto-fetched if omitted)' },
      },
      required: ['owner', 'repo', 'path', 'message', 'content', 'branch'],
    },
    tier: 'write',
    parallelSafe: false,
    availableIn: 'both',
    category: 'github',
    handler: githubCreateOrUpdateFile,
  })

  registerTool({
    name: 'github_create_branch',
    description: 'Create a new branch in a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string', description: 'New branch name' },
        from_branch: { type: 'string', description: 'Source branch (default: main)' },
      },
      required: ['owner', 'repo', 'branch'],
    },
    tier: 'write',
    parallelSafe: false,
    availableIn: 'both',
    category: 'github',
    handler: githubCreateBranch,
  })

  registerTool({
    name: 'github_create_pull_request',
    description: 'Create a pull request on GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'PR description (markdown)' },
        head: { type: 'string', description: 'Branch with changes' },
        base: { type: 'string', description: 'Target branch' },
        draft: { type: 'boolean', description: 'Create as draft PR' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    tier: 'write',
    parallelSafe: false,
    availableIn: 'both',
    category: 'github',
    handler: githubCreatePullRequest,
  })
}
