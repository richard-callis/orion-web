/**
 * GitHub integration helpers.
 *
 * Per-user GitHub Personal Access Tokens (PATs) are stored encrypted on the User
 * record (githubTokenEncrypted). Agent GitHub tools resolve the owning user from
 * the agent's createdBy and look up the token here.
 *
 * Security: tokens are encrypted with AES-256-GCM (see encryption.ts). After
 * decryption we validate the value still looks like a GitHub PAT — if it does not
 * (e.g. a substituted plaintext value), we return null rather than leaking garbage.
 */

import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'

export async function getGithubTokenForUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubTokenEncrypted: true },
  })
  if (!user?.githubTokenEncrypted) return null
  try {
    const token = decrypt(user.githubTokenEncrypted)
    // Validate it looks like a GitHub token — guards against the silent plaintext
    // passthrough in decrypt() returning a substituted/garbage value.
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      console.warn('[github] decrypted token does not match expected GitHub PAT prefix')
      return null
    }
    return token
  } catch {
    return null
  }
}

export function githubFetch(token: string, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
}

export async function verifyGithubToken(token: string): Promise<{ login: string } | null> {
  try {
    const res = await githubFetch(token, '/user')
    if (!res.ok) return null
    const data = await res.json() as { login: string }
    return { login: data.login }
  } catch {
    return null
  }
}

export async function encryptAndStoreGithubToken(userId: string, token: string, login: string): Promise<void> {
  const encrypted = encrypt(token)
  await prisma.user.update({
    where: { id: userId },
    data: { githubTokenEncrypted: encrypted, githubUsername: login },
  })
}

export async function clearGithubToken(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { githubTokenEncrypted: null, githubUsername: null },
  })
}

// Helper: turn a non-ok GitHub response into a descriptive error string,
// special-casing rate limits (403/429 with rate-limit headers).
export function handleGithubError(res: Response): string {
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
    if (remaining === '0' || retryAfter) {
      return `GitHub rate limit exceeded. Retry after: ${retryAfter ?? 'unknown'}`
    }
  }
  return `GitHub API error: ${res.status} ${res.statusText}`
}
