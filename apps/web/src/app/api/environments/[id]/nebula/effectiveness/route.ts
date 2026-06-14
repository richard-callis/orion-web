import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/effectiveness
 * Combined nebula + eval metrics for monitoring.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const entries = await prisma.nebulaInstance.findMany({
    where: { environmentId: (await params).id, isInstalled: true },
    include: {
      hookLogs: { take: 1000, orderBy: { startedAt: 'desc' } },
      skillLogs: { take: 1000, orderBy: { createdAt: 'desc' } },
    },
  })

  // AgentScore is on Environment, not NebulaInstance — fetch once per env
  const agentScores = await prisma.agentScore.findMany({
    where: {
      environmentId: (await params).id,
      targetType: { in: ['skill', 'hook'] },
    },
  })

  const results = entries.map((entry) => {
    const totalLogs = entry.hookLogs.length + entry.skillLogs.length
    const failedLogs = entry.hookLogs.filter((l) => l.status === 'failed').length
    const envScores = agentScores.filter(
      (s) =>
        s.targetType === 'skill' || s.targetType === 'hook'
    )
    return {
      name: entry.name,
      category: entry.category,
      fireRate: totalLogs,
      successRate:
        totalLogs > 0
          ? ((totalLogs - failedLogs) / totalLogs * 100).toFixed(1)
          : 0,
      needsTuning:
        totalLogs > 10 &&
        envScores.length > 0 &&
        parseFloat(String(envScores[0]?.scoreTotal ?? 0)) < 50,
    }
  })
  return NextResponse.json(results)
}
