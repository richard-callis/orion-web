/**
 * GET /api/monitoring/security/sources
 *
 * Returns SourceHealth records with computed status.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Compute the source health status from the last-seen timestamp and the
 * configured `staleAfterMs` threshold. Exported so the SIEM Review B3 invariant
 * (the 'down' branch must be reachable) is locked in unit tests.
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

export async function GET() {
  const sources = await prisma.sourceHealth.findMany({
    select: {
      source: true,
      lastSeenAt: true,
      lastWatermark: true,
      staleAfterMs: true,
      environmentId: true,
    },
  })

  const now = Date.now()

  const result = sources.map((s: any) => {
    const lastSeen = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0
    const status = computeSourceStatus(lastSeen, now, s.staleAfterMs)

    return {
      source: s.source,
      lastSeenAt: s.lastSeenAt,
      lastWatermark: s.lastWatermark,
      staleAfterMs: s.staleAfterMs,
      environmentId: s.environmentId,
      status,
    }
  })

  return NextResponse.json({ sources: result })
}
