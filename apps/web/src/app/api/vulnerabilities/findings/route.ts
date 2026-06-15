export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try { await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const environmentId = searchParams.get('environmentId') ?? undefined
  const statusFilter = searchParams.get('status') ?? undefined
  const severityFilter = searchParams.get('severity') ?? undefined
  const fixAvailable = searchParams.get('fixAvailable')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 500)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  const severityRanges: Record<string, { gte?: number; lt?: number }> = {
    critical: { gte: 90 },
    high: { gte: 70, lt: 90 },
    medium: { gte: 40, lt: 70 },
    low: { lt: 40 },
  }

  const where: Record<string, unknown> = {}
  if (environmentId) where.environmentId = environmentId
  if (statusFilter) where.status = statusFilter
  if (fixAvailable === 'true') where.fixAvailable = true
  if (fixAvailable === 'false') where.fixAvailable = false
  if (severityFilter && severityRanges[severityFilter]) {
    where.severity = severityRanges[severityFilter]
  }

  const [total, findings] = await Promise.all([
    prisma.vulnerabilityFinding.count({ where }),
    prisma.vulnerabilityFinding.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
      take: limit,
      skip: offset,
      include: { environment: { select: { name: true } } },
    }),
  ])

  return NextResponse.json({ total, findings })
}
