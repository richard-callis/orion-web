import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
export const dynamic = 'force-dynamic'

// GET /api/environments/[id]/evals/scores/skill/[skillId]
// Score for a specific skill NebulaInstance.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; skillId: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = (await params).id

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  // Find the skill NebulaInstance
  const skill = await prisma.nebulaInstance.findUnique({
    where: {
      environmentId_name: {
        environmentId: envId,
        name: (await params).skillId,
      },
      category: 'skill',
    },
  })

  if (!skill) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
  }

  // Check for an existing AgentScore
  const score = await prisma.agentScore.findUnique({
    where: {
      targetType_targetId: {
        targetType: 'skill',
        targetId: skill.id,
      },
    },
  })

  if (score) {
    return NextResponse.json({
      targetType: 'skill',
      targetId: skill.id,
      targetName: skill.name,
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
    targetType: 'skill',
    targetId: skill.id,
    targetName: skill.name,
    scoreTotal: 0,
    accuracy: 0,
    completeness: 0,
    safety: 0,
    efficiency: 0,
    quality: 0,
    evalCount: 0,
    lastEvalAt: null,
    message: 'No evals have been run for this skill yet',
  })
}
