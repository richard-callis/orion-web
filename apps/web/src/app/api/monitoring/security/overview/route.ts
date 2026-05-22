import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const envId = process.env.ENVIRONMENT_ID || ''

  // Fetch recent security events
  const recentAlerts = await prisma.securityEvent.findMany({
    where: envId ? { environmentId: envId, acknowledged: false } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { environment: true },
  })

  // Count by type and severity
  const typeCounts = await prisma.securityEvent.groupBy({
    by: ['type'],
    where: envId ? { environmentId: envId } : undefined,
    _count: true,
  })

  const severityDist = await prisma.securityEvent.groupBy({
    by: ['severity'],
    where: envId ? { environmentId: envId } : undefined,
    _count: { id: true },
    orderBy: { severity: 'desc' },
    take: 5,
  })

  const criticalCount = recentAlerts.filter(a => a.severity >= 80).length
  const highCount = recentAlerts.filter(a => a.severity >= 50 && a.severity < 80).length
  const totalUnack = recentAlerts.length

  // Incident counts
  const openIncidents = await prisma.incident.count({
    where: envId ? { environmentId: envId, status: { in: ['open', 'triaged', 'contained'] } } : undefined,
  })

  // Recent incidents
  const recentIncidents = await prisma.incident.findMany({
    where: envId ? { environmentId: envId } : undefined,
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
  const pendingApprovals = await prisma.actionAudit.count({
    where: envId ? { environmentId: envId, status: 'denied', tier: 'approve' } : { status: 'denied', tier: 'approve' },
  })

  // Pending approval list
  const pendingApprovalsList = await prisma.actionAudit.findMany({
    where: envId ? { environmentId: envId, status: 'denied', tier: 'approve' } : { status: 'denied', tier: 'approve' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      actionType: true,
      target: true,
      createdAt: true,
    },
  })

  // Risk score: 0-100 based on threat volume and severity
  const riskScore = Math.min(100, Math.max(0,
    criticalCount * 25 + highCount * 10 + totalUnack * 2
  ))

  return NextResponse.json({
    riskScore,
    activeThreats: recentAlerts.length,
    criticalCount,
    highCount,
    activeIncidents: openIncidents,
    pendingApprovals,
    recentIncidents: recentIncidents.map(i => ({
      ...i,
      openedAt: i.openedAt.toISOString(),
    })),
    pendingApprovalsList: pendingApprovalsList.map((a: any) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
    })),
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
