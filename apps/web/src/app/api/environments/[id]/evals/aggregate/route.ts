import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
export const dynamic = 'force-dynamic'

// GET /api/environments/[id]/evals/aggregate
// Chart data for eval dashboard.
// Query params: type=conversation|task|skill|hook, window=7|30|90
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = params.id

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const windowDays = parseInt(searchParams.get('window') || '7', 10)

  const since = new Date()
  since.setDate(since.getDate() - windowDays)

  // Validate type param
  const validTypes = ['conversation', 'task', 'skill', 'hook']
  if (type && !validTypes.includes(type)) {
    return NextResponse.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, { status: 400 })
  }

  // Fetch evals within the window
  const evals = await prisma.eval.findMany({
    where: {
      environmentId: envId,
      ...(type ? { targetType: type } : {}),
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      targetType: true,
      scoreTotal: true,
      scores: true,
      createdAt: true,
    },
  })

  // Group by day
  const dailyGroups: Record<string, { totalScore: number; count: number; scores: Record<string, number[]> }> = {}

  for (const e of evals) {
    const day = e.createdAt.toISOString().split('T')[0]
    if (!dailyGroups[day]) {
      dailyGroups[day] = { totalScore: 0, count: 0, scores: {} }
    }
    dailyGroups[day].totalScore += e.scoreTotal
    dailyGroups[day].count += 1

    // Parse and aggregate breakdown scores
    try {
      const parsedScores: Record<string, number> = JSON.parse(e.scores)
      for (const [key, val] of Object.entries(parsedScores)) {
        if (typeof val === 'number' && !Number.isNaN(val)) {
          if (!dailyGroups[day].scores[key]) {
            dailyGroups[day].scores[key] = []
          }
          dailyGroups[day].scores[key].push(val)
        }
      }
    } catch {
      // Skip malformed scores
    }
  }

  // Sort days and build response
  const sortedDays = Object.keys(dailyGroups).sort()

  const result: {
    labels: string[]
    scores: number[]
    count: number
    breakdown?: Record<string, number[]>
  }[] = []

  for (const day of sortedDays) {
    const group = dailyGroups[day]
    const avgScore = group.count > 0 ? group.totalScore / group.count : 0

    // Format label as "May 13"
    const date = new Date(day + 'T00:00:00Z')
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

    result.push({
      labels: [label],
      scores: [Math.round(avgScore * 10) / 10],
      count: group.count,
    })
  }

  // Also include an overall summary
  const totalEvals = evals.length
  const overallAvg = totalEvals > 0 ? evals.reduce((sum, e) => sum + e.scoreTotal, 0) / totalEvals : 0

  // Build a single aggregated result for the chart
  const allLabels: string[] = []
  const allScores: number[] = []
  const allCounts: number[] = []

  for (const item of result) {
    allLabels.push(...item.labels)
    allScores.push(...item.scores)
    allCounts.push(item.count)
  }

  return NextResponse.json({
    labels: allLabels,
    scores: allScores,
    count: allCounts,
    totalEvals,
    overallAvg: Math.round(overallAvg * 10) / 10,
    windowDays,
    targetType: type || 'all',
  })
}
