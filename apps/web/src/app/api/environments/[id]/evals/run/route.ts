import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'
export const dynamic = 'force-dynamic'

const RunEvalSchema = z.object({
  targetType: z.enum(['conversation', 'task', 'skill', 'hook']),
  targetId: z.string().min(1),
})

// POST /api/environments/[id]/evals/run
// Auto-eval trigger — evaluates a conversation or task after completion.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireServiceAuth(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const envId = params.id

  // Verify environment exists
  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const result = await parseBodyOrError(req, RunEvalSchema)
  if ('error' in result) return result.error
  const { targetType, targetId } = result.data

  // 1. Find all applicable rulesets for this target type
  const rulesets = await prisma.ruleset.findMany({
    where: {
      // criteria is JSON string — we match by parsing the triggers array
    },
  })

  // Filter rulesets whose triggers match the targetType
  const applicableRulesets = rulesets.filter((r) => {
    try {
      const triggers: string[] = JSON.parse(r.triggers || '[]')
      return triggers.includes(targetType)
    } catch {
      return false
    }
  })

  if (applicableRulesets.length === 0) {
    return NextResponse.json({
      message: 'No applicable eval rulesets found',
      targetType,
      targetId,
    })
  }

  const evalResults: { rulesetId: string; scores: Record<string, number> }[] = []

  for (const ruleset of applicableRulesets) {
    const scores: Record<string, number> = {}
    let scoreTotal = 0
    const breakdown: Record<string, { score: number; max: number; notes: string }> = {}

    try {
      const criteria: Record<string, { type: string; weight?: number; threshold?: number }> =
        JSON.parse(ruleset.criteria || '{}')

      // Evaluate each criterion based on targetType
      for (const [criterionName, criterion] of Object.entries(criteria)) {
        let rawScore = 0
        const maxScore = criterion.weight || 25
        let notes = ''

        if (targetType === 'conversation') {
          // Fetch conversation data for evaluation
          const conversation = await prisma.conversation.findUnique({
            where: { id: targetId },
            include: {
              messages: true,
              invocations: true,
            },
          })

          if (!conversation) continue

          if (criterion.type === 'tool_count') {
            const toolCallCount = conversation.invocations.filter((i) => i.toolsUsed && (i.toolsUsed as string).length > 0).length
            const maxAllowed = criterion.threshold || 10
            rawScore = Math.min(toolCallCount, maxAllowed)
            notes = `Tool calls: ${toolCallCount}/${maxAllowed}`
          } else if (criterion.type === 'safety_check') {
            // Check that all tool calls were valid invocations
            const unsafe = conversation.invocations.filter((i) => !i.success).length
            rawScore = unsafe === 0 ? maxScore : maxScore * 0.5
            notes = `Unsafe invocations: ${unsafe}`
          } else if (criterion.type === 'completeness_check') {
            // Check if conversation has user -> assistant -> result pattern
            const hasResults = conversation.messages.some((m) => m.role === 'tool_result')
            rawScore = hasResults ? maxScore : 0
            notes = hasResults ? 'Has tool results' : 'No tool results found'
          } else if (criterion.type === 'response_quality') {
            // Heuristic: quality based on response length and token usage
            const totalTokens = conversation.invocations.reduce((sum, i) => sum + (i.tokensUsed || 0), 0)
            const hasContent = conversation.messages.some((m) => m.content.length > 10)
            rawScore = hasContent ? Math.min(maxScore, Math.floor(totalTokens / 100)) : 0
            notes = `Tokens used: ${totalTokens}`
          }
        } else if (targetType === 'task') {
          const task = await prisma.task.findUnique({ where: { id: targetId } })
          if (!task) continue

          if (criterion.type === 'tool_count') {
            // For tasks, count tool invocations from associated conversations
            const relatedConvos = await prisma.conversation.findMany({
              where: {
                messages: {
                  some: { id: targetId },
                },
              },
              include: { invocations: true },
            })
            const totalTools = relatedConvos.reduce(
              (sum, c) => sum + (c.invocations?.length || 0),
              0
            )
            const maxAllowed = criterion.threshold || 10
            rawScore = Math.min(totalTools, maxAllowed)
            notes = `Tools used: ${totalTools}/${maxAllowed}`
          } else if (criterion.type === 'safety_check') {
            const failedInvocations = await prisma.claudeInvocation.count({
              where: { conversation: { messages: { some: { id: targetId } } }, success: false },
            })
            rawScore = failedInvocations === 0 ? maxScore : maxScore * 0.5
            notes = `Failed invocations: ${failedInvocations}`
          } else if (criterion.type === 'completeness_check') {
            const isCompleted = task.status === 'completed' || task.status === 'done'
            rawScore = isCompleted ? maxScore : 0
            notes = `Task status: ${task.status}`
          } else if (criterion.type === 'response_quality') {
            rawScore = maxScore * 0.8 // Default for completed tasks
            notes = 'Task completed'
          }
        }

        scores[criterionName] = rawScore
        scoreTotal += rawScore
        breakdown[criterionName] = { score: rawScore, max: maxScore, notes }
      }
    } catch (err) {
      // If a ruleset's criteria can't be parsed, skip it
      console.error(`Failed to evaluate ruleset ${ruleset.id}:`, err)
      continue
    }

    evalResults.push({ rulesetId: ruleset.id, scores })
  }

  // 2. Create Eval records for each ruleset
  const createdEvals = []
  for (const result of evalResults) {
    const scoreEntries = Object.entries(result.scores)
    const maxPossible = scoreEntries.reduce((sum, [, s]) => sum + s, 0)
    const scoreTotalPct = maxPossible > 0 ? Math.min(100, (Object.values(result.scores).reduce((a, b) => a + b, 0) / maxPossible) * 100) : 0

    const evalRecord = await prisma.eval.create({
      data: {
        environmentId: envId,
        targetType,
        targetId,
        evalType: 'auto_rule',
        rulesetId: result.rulesetId,
        scores: JSON.stringify(result.scores),
        scoreTotal: scoreTotalPct,
        scoreBreakdown: JSON.stringify(
          evalResults.find((e) => e.rulesetId === result.rulesetId)?.scores || {}
        ),
        feedback: `Auto-eval triggered for ${targetType} ${targetId}`,
        evidence: JSON.stringify({
          targetType,
          targetId,
          rulesetId: result.rulesetId,
          criteria: Object.keys(result.scores),
        }),
      },
    })
    createdEvals.push(evalRecord)
  }

  // 3. Update or create AgentScore for the target
  const existingScore = await prisma.agentScore.findUnique({
    where: {
      targetType_targetId: { targetType, targetId },
    },
  })

  if (existingScore) {
    const allEvalsForTarget = await prisma.eval.findMany({
      where: { targetType, targetId },
      select: { scores: true, scoreTotal: true },
    })

    const scores: Record<string, number> = {}
    for (const evalRec of allEvalsForTarget) {
      try {
        const parsed = JSON.parse(evalRec.scores)
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'number') {
            scores[key] = (scores[key] || 0) + val
          }
        }
      } catch {
        // skip malformed scores
      }
    }

    const totalKeys = new Set()
    for (const evalRec of allEvalsForTarget) {
      try {
        const parsed = JSON.parse(evalRec.scores)
        for (const key of Object.keys(parsed)) totalKeys.add(key)
      } catch {
        // skip
      }
    }

    const avgScores: Record<string, number> = {}
    const count = allEvalsForTarget.length || 1
    for (const key of totalKeys) {
      avgScores[key] = Math.round((scores[key] || 0) / count * 10) / 10
    }

    // Map avg scores to AgentScore fields
    const safety = avgScores['safety_check'] ?? existingScore.safety
    const completeness = avgScores['completeness_check'] ?? existingScore.completeness
    const efficiency = avgScores['tool_count'] ?? existingScore.efficiency
    const quality = avgScores['response_quality'] ?? existingScore.quality
    const accuracy = Object.keys(avgScores).length > 0 ? (scoreTotalPct + (safety ?? 0) * 0.5) / 2 : 0

    await prisma.agentScore.update({
      where: { id: existingScore.id },
      data: {
        scoreTotal: Math.min(100, existingScore.scoreTotal * 0.7 + scoreTotalPct * 0.3),
        accuracy: Math.min(100, accuracy),
        safety: Math.min(100, (safety ?? 0) * 10),
        completeness: Math.min(100, (completeness ?? 0) * 10),
        efficiency: Math.min(100, (efficiency ?? 0) * 10),
        quality: Math.min(100, (quality ?? 0) * 10),
        evalCount: existingScore.evalCount + createdEvals.length,
        lastEvalAt: new Date(),
      },
    })
  } else {
    await prisma.agentScore.create({
      data: {
        environmentId: envId,
        targetType,
        targetId,
        scoreTotal: scoreTotalPct,
        safety: 0,
        completeness: 0,
        quality: 0,
        evalCount: createdEvals.length,
        lastEvalAt: new Date(),
      },
    })
  }

  return NextResponse.json({
    message: 'Eval completed',
    evalsCreated: createdEvals.length,
    evals: createdEvals.map((e) => ({
      id: e.id,
      scoreTotal: e.scoreTotal,
      rulesetId: e.rulesetId,
    })),
  })
}
