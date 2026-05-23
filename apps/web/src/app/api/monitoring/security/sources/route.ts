/**
 * GET /api/monitoring/security/sources
 *
 * Returns SourceHealth records with computed status.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeSourceStatus } from '@/lib/security/source-health-utils'

export const dynamic = 'force-dynamic'

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
