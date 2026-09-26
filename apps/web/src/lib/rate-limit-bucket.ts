/**
 * SOC2 [M6]: rate-limit bucket naming for middleware.ts.
 *
 * Buckets used to be keyed by the exact pathname, so every new conversation/task id
 * got a fresh quota — the 30-request /api/chat limit (LLM cost control) could be
 * bypassed by creating new conversations.
 *
 * - Mutating requests under a COST_SHARED_PREFIXES entry share ONE bucket per
 *   matched prefix (every POST under /api/chat counts against the same 30).
 * - Everything else is keyed by the pathname with id-like segments collapsed to
 *   ":id", so /api/tasks/abc/events and /api/tasks/xyz/events share a bucket but
 *   distinct endpoints (list vs events vs chat) keep their own. Keying every GET by
 *   prefix would make routine UI polling exhaust the tight write limits.
 */

/** Prefixes whose writes spawn LLM or agent work and must share one quota. */
export const COST_SHARED_PREFIXES = ['/api/chat', '/api/tools/generate', '/api/tasks']

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for path segments that look like record ids rather than route names. */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true
  if (UUID_RE.test(segment)) return true
  // cuid / cuid2 / nanoid / hex ids: long, url-safe, and containing a digit.
  // Route names in this app are lowercase words without digits.
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment)
}

export function normalizeRatePath(pathname: string): string {
  return pathname
    .split('/')
    .map(seg => (seg && isIdSegment(seg) ? ':id' : seg))
    .join('/')
}

/**
 * @param matchedPrefix the RATE_LIMITS key that matched (null when the default applied)
 */
export function rateLimitBucket(pathname: string, method: string, matchedPrefix: string | null): string {
  if (
    matchedPrefix &&
    MUTATING_METHODS.has(method.toUpperCase()) &&
    COST_SHARED_PREFIXES.includes(matchedPrefix)
  ) {
    return matchedPrefix
  }
  return normalizeRatePath(pathname)
}
