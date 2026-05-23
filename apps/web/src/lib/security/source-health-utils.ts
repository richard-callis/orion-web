/**
 * Utility functions for SourceHealth status computation.
 * Extracted from sources/route.ts so they can be unit-tested without
 * triggering Next.js route export validation.
 */

/**
 * Compute the source health status from the last-seen timestamp and the
 * configured `staleAfterMs` threshold.
 *
 * Ladder:
 *   - lastSeenAt missing (0)      → 'down'
 *   - elapsed > staleAfterMs * 2  → 'down'
 *   - elapsed > staleAfterMs      → 'stale'
 *   - otherwise                    → 'healthy'
 */
export function computeSourceStatus(
  lastSeenMs: number,
  nowMs: number,
  staleAfterMs: number,
): 'healthy' | 'stale' | 'down' {
  if (lastSeenMs === 0) return 'down'
  const elapsed = nowMs - lastSeenMs
  if (elapsed > staleAfterMs * 2) return 'down'
  if (elapsed > staleAfterMs) return 'stale'
  return 'healthy'
}
