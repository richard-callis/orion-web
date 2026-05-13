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

  // Risk score: 0-100 based on threat volume and severity
  const riskScore = Math.min(100, Math.max(0,
    criticalCount * 25 + highCount * 10 + totalUnack * 2
  ))

  return NextResponse.json({
    riskScore,
    activeThreats: recentAlerts.length,
    criticalCount,
    highCount,
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
