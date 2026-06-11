import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = process.env.ENVIRONMENT_ID || ''
  const envFilter = envId ? { environmentId: envId } : {}
  const unackFilter = envId ? { environmentId: envId, acknowledged: false } : { acknowledged: false }

  // Use DB aggregates for counts — deriving these from a 20-row slice caused
  // the risk score and threat counts to understate real volume during high-traffic attacks.
  const [criticalCount, highCount, totalUnack, openIncidents] = await Promise.all([
    prisma.securityEvent.count({ where: { ...unackFilter, severity: { gte: 80 } } }),
    prisma.securityEvent.count({ where: { ...unackFilter, severity: { gte: 50, lt: 80 } } }),
    prisma.securityEvent.count({ where: unackFilter }),
    prisma.incident.count({
      where: { ...envFilter, status: { in: ['open', 'triaged', 'contained'] } },
    }),
  ])

  // Recent alerts for the feed (display only — not used for counts/risk)
  const recentAlerts = await prisma.securityEvent.findMany({
    where: unackFilter,
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  // Count by type for blockCount / anomalyCount
  const typeCounts = await prisma.securityEvent.groupBy({
    by: ['type'],
    where: envFilter.environmentId ? envFilter : undefined,
    _count: true,
  })

  // Recent incidents
  const recentIncidents = await prisma.incident.findMany({
    where: envFilter.environmentId ? envFilter : undefined,
    orderBy: { openedAt: 'desc' },
    take: 5,
    select: {
      id: true,
      status: true,
      severity: true,
      rootCauseSummary: true,
      attackerKey: true,
      openedAt: true,
    },
  })

  // Pending approvals
  const pendingApprovalWhere = envId
    ? { environmentId: envId, status: 'pending', tier: 'approve' }
    : { status: 'pending', tier: 'approve' }

  const [pendingApprovals, pendingApprovalsList] = await Promise.all([
    prisma.actionAudit.count({ where: pendingApprovalWhere }),
    prisma.actionAudit.findMany({
      where: pendingApprovalWhere,
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, actionType: true, target: true, createdAt: true },
    }),
  ])

  // Risk score: 0-100 based on real aggregate counts (not capped at 20)
  const riskScore = Math.min(100, Math.max(0,
    criticalCount * 25 + highCount * 10 + Math.min(totalUnack, 10) * 2
  ))

  // Recent investigations
  const recentInvestigations = await prisma.investigation.findMany({
    where: { status: { in: ['open', 'active'] } },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: {
      id: true,
      name: true,
      status: true,
      severity: true,
      _count: { select: { incidents: true, observables: true, notes: true } },
    },
  })

  return NextResponse.json({
    riskScore,
    activeThreats: totalUnack,
    criticalCount,
    highCount,
    activeIncidents: openIncidents,
    pendingApprovals,
    recentIncidents: recentIncidents.map(i => ({ ...i, openedAt: i.openedAt.toISOString() })),
    recentInvestigations,
    pendingApprovalsList: pendingApprovalsList.map(a => ({ ...a, createdAt: a.createdAt.toISOString() })),
    recentAlerts: recentAlerts.map(a => ({
      id: a.id,
      type: a.type,
      source: a.source,
      severity: a.severity,
      title: a.title,
      acknowledged: a.acknowledged,
      createdAt: a.createdAt,
    })),
    blockCount: (typeCounts.find(t => t.type === 'crowdsec_block')?._count ?? 0) as number,
    anomalyCount: (typeCounts.find(t => t.type === 'anomaly')?._count ?? 0) as number,
  })
}
