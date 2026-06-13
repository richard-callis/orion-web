import { prisma } from './db'

// ─── Redis budget lock helpers ────────────────────────────────────────────────
// SOC2: [H-TOCTOU] Per-agent mutex prevents concurrent tasks from all reading
// the same "current usage" before any of them records spend.

let _budgetRedisClient: any = null

async function getBudgetRedis(): Promise<any | null> {
  if (_budgetRedisClient) return _budgetRedisClient
  try {
    const ioredis = await import('ioredis')
    const Redis = ioredis.default || ioredis
    const url =
      process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || 'redis://localhost:6379/0'
    const client = new Redis(url)
    await client.ping()
    _budgetRedisClient = client
    return _budgetRedisClient
  } catch {
    return null
  }
}

/**
 * SOC2: [H-TOCTOU] Acquire a per-agent budget lock using SET NX EX.
 * Returns the lock token string if acquired, or null if the lock is already held.
 * Returns 'no-redis' when Redis is unavailable (fail-open — allow the task to proceed).
 */
export async function acquireBudgetLock(agentId: string): Promise<string | null> {
  const redis = await getBudgetRedis()
  if (!redis) return 'no-redis' // fail open when Redis is unavailable
  const token = `${Date.now()}-${Math.random()}`
  const key = `agent:${agentId}:budget:lock`
  const result = await redis.set(key, token, 'NX', 'EX', 30)
  return result === 'OK' ? token : null
}

/**
 * SOC2: [H-TOCTOU] Release the per-agent budget lock using a Lua check-and-delete
 * so we only release the lock we own (guards against expiry races).
 */
export async function releaseBudgetLock(agentId: string, token: string): Promise<void> {
  if (token === 'no-redis') return
  const redis = await getBudgetRedis()
  if (!redis) return
  const key = `agent:${agentId}:budget:lock`
  const lua = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `
  await redis.eval(lua, 1, key, token)
}

/**
 * Check whether an agent is within its token budget (daily and monthly).
 *
 * Sums AgentTokenUsage for today (UTC midnight boundary) and the current
 * calendar month, then compares against tokenBudgetDay / tokenBudgetMonth.
 *
 * Returns { allowed: true } when under budget or no budget is set.
 * Returns { allowed: false, reason: '...' } when a limit is exceeded.
 *
 * SOC2: [H-TOCTOU] Callers MUST hold the per-agent budget lock before calling
 * this function to prevent concurrent tasks reading the same stale usage total.
 * Use acquireBudgetLock / releaseBudgetLock in the caller (e.g. worker.ts).
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
  modelId?: string,
): Promise<void> {
  if (inputTokens === 0 && outputTokens === 0) return
  await prisma.agentTokenUsage.create({
    data: { agentId, taskId, inputTokens, outputTokens, ...(modelId ? { modelId } : {}) },
  })
}
