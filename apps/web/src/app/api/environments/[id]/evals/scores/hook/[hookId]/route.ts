import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
export const dynamic = 'force-dynamic'

// GET /api/environments/[id]/evals/scores/hook/[hookId]
// Score for a specific hook NebulaInstance.
export async function GET(_req: NextRequest, { params }: { params: { id: string; hookId: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = params.id

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  // Find the hook NebulaInstance
  const hook = await prisma.nebulaInstance.findUnique({
    where: {
      environmentId_name: {
        environmentId: envId,
        name: params.hookId,
      },
      category: 'hook',
    },
  })

  if (!hook) {
    return NextResponse.json({ error: 'Hook not found' }, { status: 404 })
  }

  // Check for an existing AgentScore
  const score = await prisma.agentScore.findUnique({
    where: {
      targetType_targetId: {
        targetType: 'hook',
        targetId: hook.id,
      },
    },
  })

  if (score) {
    return NextResponse.json({
      targetType: 'hook',
      targetId: hook.id,
      targetName: hook.name,
      scoreTotal: score.scoreTotal,
      accuracy: score.accuracy,
      completeness: score.completeness,
      safety: score.safety,
      efficiency: score.efficiency,
      quality: score.quality,
      evalCount: score.evalCount,
      lastEvalAt: score.lastEvalAt,
    })
  }

  // No score yet — return a default with zero scores
  return NextResponse.json({
    targetType: 'hook',
    targetId: hook.id,
    targetName: hook.name,
    scoreTotal: 0,
    accuracy: 0,
    completeness: 0,
    safety: 0,
    efficiency: 0,
    quality: 0,
    evalCount: 0,
    lastEvalAt: null,
    message: 'No evals have been run for this hook yet',
  })
}
