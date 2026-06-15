export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export async function GET() {
  try { await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [critical, high, medium, low, byEnv, recentScans] = await Promise.all([
    prisma.vulnerabilityFinding.count({ where: { status: 'open', severity: { gte: 90 } } }),
    prisma.vulnerabilityFinding.count({ where: { status: 'open', severity: { gte: 70, lt: 90 } } }),
    prisma.vulnerabilityFinding.count({ where: { status: 'open', severity: { gte: 40, lt: 70 } } }),
    prisma.vulnerabilityFinding.count({ where: { status: 'open', severity: { lt: 40 } } }),
    prisma.vulnerabilityFinding.groupBy({
      by: ['environmentId'],
      where: { status: 'open' },
      _count: { id: true },
      _max: { severity: true },
    }),
    prisma.vulnerabilityScan.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
      include: { environment: { select: { name: true } } },
    }),
  ])

  const envIds = byEnv.map(r => r.environmentId)
  const envs = await prisma.environment.findMany({
    where: { id: { in: envIds } },
    select: { id: true, name: true },
  })
  const envMap = Object.fromEntries(envs.map(e => [e.id, e.name]))

  return NextResponse.json({
    critical, high, medium, low,
    total: critical + high + medium + low,
    envsAffected: byEnv.length,
    byEnvironment: byEnv.map(r => ({
      environmentId: r.environmentId,
      environmentName: envMap[r.environmentId] ?? r.environmentId,
      openCount: r._count.id,
      maxSeverity: r._max.severity,
    })),
    recentScans,
  })
}
