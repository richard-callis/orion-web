import { prisma } from './db'

/**
 * Check whether an agent is within its token budget (daily and monthly).
 *
 * Sums AgentTokenUsage for today (UTC midnight boundary) and the current
 * calendar month, then compares against tokenBudgetDay / tokenBudgetMonth.
 *
 * Returns { allowed: true } when under budget or no budget is set.
 * Returns { allowed: false, reason: '...' } when a limit is exceeded.
 */
export async function checkAgentBudget(
  agentId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { tokenBudgetDay: true, tokenBudgetMonth: true },
  })

  if (!agent) return { allowed: true }

  const now = new Date()

  // Day boundary — UTC midnight of today
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  // Month boundary — first of the current UTC calendar month
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  // Only query if we need to
  if (agent.tokenBudgetDay == null && agent.tokenBudgetMonth == null) {
    return { allowed: true }
  }

  const [dayAgg, monthAgg] = await Promise.all([
    agent.tokenBudgetDay != null
      ? prisma.agentTokenUsage.aggregate({
          where: { agentId, recordedAt: { gte: dayStart } },
          _sum: { inputTokens: true, outputTokens: true },
        })
      : null,
    agent.tokenBudgetMonth != null
      ? prisma.agentTokenUsage.aggregate({
          where: { agentId, recordedAt: { gte: monthStart } },
          _sum: { inputTokens: true, outputTokens: true },
        })
      : null,
  ])

  if (dayAgg && agent.tokenBudgetDay != null) {
    const used = (dayAgg._sum.inputTokens ?? 0) + (dayAgg._sum.outputTokens ?? 0)
    if (used >= agent.tokenBudgetDay) {
      return {
        allowed: false,
        reason: `Daily token budget exceeded (used ${used.toLocaleString()} / limit ${agent.tokenBudgetDay.toLocaleString()})`,
      }
    }
  }

  if (monthAgg && agent.tokenBudgetMonth != null) {
    const used = (monthAgg._sum.inputTokens ?? 0) + (monthAgg._sum.outputTokens ?? 0)
    if (used >= agent.tokenBudgetMonth) {
      return {
        allowed: false,
        reason: `Monthly token budget exceeded (used ${used.toLocaleString()} / limit ${agent.tokenBudgetMonth.toLocaleString()})`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Record token usage for a completed task run.
 * Creates an AgentTokenUsage row so future budget checks include this spend.
 */
export async function recordTokenUsage(
  agentId: string,
  taskId: string | null,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (inputTokens === 0 && outputTokens === 0) return
  await prisma.agentTokenUsage.create({
    data: { agentId, taskId, inputTokens, outputTokens },
  })
}
