/**
 * AGENTS.md Loader
 *
 * Reads an AGENTS.md file from the root of an environment's linked Gitea repo
 * and caches the result per environment for 5 minutes.
 *
 * Supports file-based agent instruction layering — operators can commit
 * agent instructions alongside their infrastructure code, version-controlled
 * and reviewable in PRs (same pattern as Codex / Claude Code AGENTS.md support).
 */

import { prisma } from './db'
import { getFileContent } from './gitea'

// Cache AGENTS.md content per environment, TTL 5 minutes
const cache = new Map<string, { content: string; fetchedAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Fetch AGENTS.md from the environment's linked Gitea repo.
 * Returns the file content as a string, or null if:
 *   - The environment has no linked repo
 *   - The file does not exist in the repo
 *   - Any error occurs during fetch
 *
 * Results are cached per environmentId for 5 minutes.
 */
export async function getAgentsMd(environmentId: string): Promise<string | null> {
  const cached = cache.get(environmentId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content || null
  }

  try {
    // Get the environment's Gitea repo info
    const env = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { gitOwner: true, gitRepo: true },
    })
    if (!env?.gitOwner || !env?.gitRepo) return null

    // Read AGENTS.md from the repo root via the Gitea file content API
    const content = await getFileContent(env.gitOwner, env.gitRepo, 'AGENTS.md')

    cache.set(environmentId, { content: content ?? '', fetchedAt: Date.now() })
    return content
  } catch {
    return null
  }
}

/** Invalidate cached AGENTS.md for an environment (e.g. after a push webhook). */
export function invalidateAgentsMdCache(environmentId: string) {
  cache.delete(environmentId)
}
