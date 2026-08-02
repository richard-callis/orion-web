import { prisma } from './db'

// Length-based fallback estimate for providers/paths that don't report real
// usage (e.g. the orion-claude sidecar's /run/collect doesn't reliably surface
// it). Conservative ~4 chars/token heuristic — better than recording zero,
// which would defeat the point of budget tracking and, for callers gating
// behavior on token count (e.g. compaction), would mean that behavior never
// triggers at all.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

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

// ─── In-flight budget reservations (TOCTOU fix) ────────────────────────────────
// SOC2: [H-TOCTOU] The budget lock only serializes the *check*, not the *write* —
// recordTokenUsage() (the real spend write) doesn't happen until task completion,
// up to TASK_TIMEOUT_MS later. Without a reservation, N concurrent tasks for the
// same agent could all pass checkAgentBudget() against the same stale total
// before any of them records spend. To close this window, checkAgentBudget()
// passing immediately reserves an estimated token count in Redis (INCRBY with a
// TTL matching the max task duration) and includes any outstanding reservation
// in its sum. The reservation is released when the task completes/fails and the
// real usage is recorded (see releaseBudgetReservation in worker.ts's finally).

// Matches worker.ts TASK_TIMEOUT_MS (60 min) — a reservation should never outlive
// the longest a task run is allowed to take, so a crashed worker's reservation
// self-expires instead of permanently blocking the agent's budget.
const RESERVATION_TTL_SEC = 60 * 60

// Conservative estimate of tokens a single task run might consume, used only to
// hold budget headroom between the check and the real spend write. Overridable
// via env for deployments with very large/small typical task token usage.
const DEFAULT_RESERVATION_TOKENS =
  parseInt(process.env.BUDGET_RESERVATION_ESTIMATE_TOKENS ?? '', 10) || 50_000

function inflightKey(agentId: string): string {
  return `agent:${agentId}:budget:inflight`
}

/**
 * SOC2: [H-TOCTOU] Reserve an estimated token count for an in-flight task run.
 * Call immediately after checkAgentBudget() returns allowed:true, while still
 * holding the per-agent budget lock. Returns the amount reserved (0 if Redis is
 * unavailable — fail-open, consistent with acquireBudgetLock's fail-open policy).
 */
export async function reserveBudgetTokens(
  agentId: string,
  estimatedTokens: number = DEFAULT_RESERVATION_TOKENS,
): Promise<number> {
  const redis = await getBudgetRedis()
  if (!redis) return 0
  const key = inflightKey(agentId)
  await redis.incrby(key, estimatedTokens)
  await redis.expire(key, RESERVATION_TTL_SEC)
  return estimatedTokens
}

/**
 * SOC2: [H-TOCTOU] Release a previously-made reservation once the task's real
 * usage has been (or is about to be) recorded via recordTokenUsage(). Safe to
 * call with amount 0 (no-op).
 */
export async function releaseBudgetReservation(agentId: string, amount: number): Promise<void> {
  if (!amount) return
  const redis = await getBudgetRedis()
  if (!redis) return
  const key = inflightKey(agentId)
  const remaining = await redis.decrby(key, amount)
  if (remaining <= 0) await redis.del(key).catch(() => {})
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

  const redis = await getBudgetRedis()
  const inflightRaw = redis ? await redis.get(inflightKey(agentId)).catch(() => null) : null
  // SOC2: [H-TOCTOU] Include any outstanding in-flight reservation (tasks that
  // passed this check but haven't recorded real spend yet) in both sums so a
  // burst of concurrent task starts can't all pass against the same stale total.
  const inflight = inflightRaw ? parseInt(inflightRaw, 10) || 0 : 0

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
    const used = (dayAgg._sum.inputTokens ?? 0) + (dayAgg._sum.outputTokens ?? 0) + inflight
    if (used >= agent.tokenBudgetDay) {
      return {
        allowed: false,
        reason: `Daily token budget exceeded (used ${used.toLocaleString()} / limit ${agent.tokenBudgetDay.toLocaleString()})`,
      }
    }
  }

  if (monthAgg && agent.tokenBudgetMonth != null) {
    const used = (monthAgg._sum.inputTokens ?? 0) + (monthAgg._sum.outputTokens ?? 0) + inflight
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
  // SOC2: Do NOT early-return on zero counts — always write an audit row so that
  // task execution is always recorded. A compromised worker reporting zero counts
  // would otherwise hide its actual spend and leave no DB record for budget checks.
  await prisma.agentTokenUsage.create({
    data: { agentId, taskId, inputTokens, outputTokens, ...(modelId ? { modelId } : {}) },
  })
}
