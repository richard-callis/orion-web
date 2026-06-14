import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
export const dynamic = 'force-dynamic'

// GET /api/environments/[id]/evals/scores
// Score overview for all targets in an environment.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = (await params).id

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  // Get all AgentScores for this environment
  const scores = await prisma.agentScore.findMany({
    where: { environmentId: envId },
    orderBy: { updatedAt: 'desc' },
  })

  const result = scores.map((s) => ({
    targetType: s.targetType,
    targetId: s.targetId,
    scoreTotal: s.scoreTotal,
    accuracy: s.accuracy,
    completeness: s.completeness,
    safety: s.safety,
    efficiency: s.efficiency,
    quality: s.quality,
    evalCount: s.evalCount,
  }))

  return NextResponse.json(result)
}
