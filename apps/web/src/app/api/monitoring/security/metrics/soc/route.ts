/**
 * GET /api/monitoring/security/metrics/soc
 *
 * SOC metrics: MTTD, MTTR, open/closed counts, cases by severity.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const now = new Date()
  const dayMs = 86400000

  // Counts by status
  const byStatus = await prisma.investigation.groupBy({
    by: ['status'],
    _count: { id: true },
  })

  // Counts by resolution type
  const byResolution = await prisma.investigation.groupBy({
    by: ['resolutionType'],
    _count: { id: true },
    where: { resolutionType: { not: null } },
  })

  // Open investigations by severity ranges
  const openBySeverity = await prisma.investigation.groupBy({
    by: ['severity'],
    _count: { id: true },
    where: { status: { in: ['open', 'active', 'suspended'] } },
  })

  const severityBuckets = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const s of openBySeverity) {
    if (s.severity >= 80) severityBuckets.critical++
    else if (s.severity >= 60) severityBuckets.high++
    else if (s.severity >= 40) severityBuckets.medium++
    else severityBuckets.low++
  }

  // MTTD & MTTR from completed investigations
  const completed = await prisma.investigation.findMany({
    where: { resolvedAt: { not: null } },
    select: { startedAt: true, resolvedAt: true, incidents: { select: { openedAt: true } } },
  })

  let totalMttD = 0
  let totalMttr = 0
  let countMttD = 0
  let countMttr = 0

  for (const inv of completed) {
    if (inv.incidents.length > 0 && inv.resolvedAt) {
      const firstIncident = inv.incidents.reduce((earliest, inc) =>
        inc.openedAt < earliest.openedAt ? inc : earliest
      )
      const mttd = (inv.startedAt.getTime() - firstIncident.openedAt.getTime()) / dayMs
      totalMttD += mttd
      countMttD++

      const mttr = (inv.resolvedAt.getTime() - inv.startedAt.getTime()) / dayMs
      totalMttr += mttr
      countMttr++
    }
  }

  // Recent investigations (last 7 days)
  const recent = await prisma.investigation.count({
    where: { createdAt: { gte: new Date(now.getTime() - 7 * dayMs) } },
  })

  // Observable counts
  const totalObservables = await prisma.investigationObservable.count()
  const maliciousObservables = await prisma.investigationObservable.count({
    where: { verdict: 'malicious' },
  })

  return NextResponse.json({
    byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count.id])),
    byResolution: Object.fromEntries(byResolution.map(r => [r.resolutionType, r._count.id])),
    severityBuckets,
    mttd: countMttD ? Math.round((totalMttD / countMttD) * 100) / 100 : null,
    mttr: countMttr ? Math.round((totalMttr / countMttr) * 100) / 100 : null,
    recent7d: recent,
    totalObservables,
    maliciousObservables,
  })
}
