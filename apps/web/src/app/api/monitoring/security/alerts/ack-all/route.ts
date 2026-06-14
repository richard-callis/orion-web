import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/monitoring/security/alerts/ack-all
 *
 * Acknowledges all unacknowledged SecurityEvent rows. Optionally scoped to
 * events within a time window via `?minutes=N` (default: all time).
 *
 * Returns { acknowledged: number } — the count of rows updated.
 */
export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { searchParams } = new URL(req.url)
  const minutes = searchParams.get('minutes') ? parseInt(searchParams.get('minutes')!) : null

  const where = {
    acknowledged: false,
    ...(minutes != null && minutes > 0
      ? { createdAt: { gte: new Date(Date.now() - minutes * 60 * 1000) } }
      : {}),
  }

  const { count } = await prisma.securityEvent.updateMany({
    where,
    data: { acknowledged: true, acknowledgedAt: new Date() },
  })

  return NextResponse.json({ acknowledged: count })
}
