import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /api/agents/:id/token-usage
 *
 * Returns token usage summary for the agent for today (UTC) and the current
 * calendar month, along with the configured budget limits and utilisation
 * percentages.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const agent = await prisma.agent.findUnique({
    where: { id: params.id },
    select: { tokenBudgetDay: true, tokenBudgetMonth: true },
  })
  if (!agent) return new NextResponse(null, { status: 404 })

  const now = new Date()
  const dayStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const [dayAgg, monthAgg] = await Promise.all([
    prisma.agentTokenUsage.aggregate({
      where: { agentId: params.id, recordedAt: { gte: dayStart } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.agentTokenUsage.aggregate({
      where: { agentId: params.id, recordedAt: { gte: monthStart } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
  ])

  const dayInput   = dayAgg._sum.inputTokens   ?? 0
  const dayOutput  = dayAgg._sum.outputTokens  ?? 0
  const dayTotal   = dayInput + dayOutput

  const monthInput  = monthAgg._sum.inputTokens   ?? 0
  const monthOutput = monthAgg._sum.outputTokens  ?? 0
  const monthTotal  = monthInput + monthOutput

  const dayUsedPct = agent.tokenBudgetDay != null
    ? Math.min(100, (dayTotal / agent.tokenBudgetDay) * 100)
    : null

  const monthUsedPct = agent.tokenBudgetMonth != null
    ? Math.min(100, (monthTotal / agent.tokenBudgetMonth) * 100)
    : null

  return NextResponse.json({
    today: { input: dayInput, output: dayOutput, total: dayTotal },
    month: { input: monthInput, output: monthOutput, total: monthTotal },
    budgetDay:    agent.tokenBudgetDay,
    budgetMonth:  agent.tokenBudgetMonth,
    dayUsedPct,
    monthUsedPct,
  })
}
