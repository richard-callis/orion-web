import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agents/:id/token-usage
 *
 * Returns token usage summary for the agent for today (UTC), the current
 * calendar month, and a 7-day sparkline.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireServiceAuth(req)
  const agent = await prisma.agent.findUnique({
    where: { id: (await params).id },
    select: { tokenBudgetDay: true, tokenBudgetMonth: true },
  })
  if (!agent) return new NextResponse(null, { status: 404 })

  const now = new Date()
  const dayStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
  sevenDaysAgo.setHours(0, 0, 0, 0)

  const [dayAgg, monthAgg, weekRecords] = await Promise.all([
    prisma.agentTokenUsage.aggregate({
      where: { agentId: (await params).id, recordedAt: { gte: dayStart } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.agentTokenUsage.aggregate({
      where: { agentId: (await params).id, recordedAt: { gte: monthStart } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.agentTokenUsage.findMany({
      where: { agentId: (await params).id, recordedAt: { gte: sevenDaysAgo } },
      select: { inputTokens: true, outputTokens: true, recordedAt: true },
      orderBy: { recordedAt: 'asc' },
    }),
  ])

  const dayInput   = dayAgg._sum.inputTokens   ?? 0
  const dayOutput  = dayAgg._sum.outputTokens  ?? 0
  const dayTotal   = dayInput + dayOutput

  const monthInput  = monthAgg._sum.inputTokens   ?? 0
  const monthOutput = monthAgg._sum.outputTokens  ?? 0
  const monthTotal  = monthInput + monthOutput

  // Build 7-day sparkline
  const sparklineMap = new Map<string, number>()
  for (const r of weekRecords) {
    const key = r.recordedAt.toISOString().slice(0, 10)
    sparklineMap.set(key, (sparklineMap.get(key) ?? 0) + r.inputTokens + r.outputTokens)
  }
  const sparkline: Array<{ date: string; tokens: number }> = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDaysAgo)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    sparkline.push({ date: key, tokens: sparklineMap.get(key) ?? 0 })
  }

  return NextResponse.json({
    today: {
      inputTokens: dayInput,
      outputTokens: dayOutput,
      total: dayTotal,
      budget: agent.tokenBudgetDay ?? null,
      pct: agent.tokenBudgetDay != null
        ? Math.min(100, Math.round((dayTotal / agent.tokenBudgetDay) * 100))
        : null,
    },
    month: {
      inputTokens: monthInput,
      outputTokens: monthOutput,
      total: monthTotal,
      budget: agent.tokenBudgetMonth ?? null,
      pct: agent.tokenBudgetMonth != null
        ? Math.min(100, Math.round((monthTotal / agent.tokenBudgetMonth) * 100))
        : null,
    },
    sparkline,
  })
}
