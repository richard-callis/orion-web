/**
 * Budget enforcement for interactive LLM entry points (room agents, agent chat).
 *
 * Previously only worker.ts task runs called checkAgentBudget(): room agents
 * recorded usage but never checked it, and direct agent chat neither recorded
 * nor checked. This module wraps the same lock → check → reserve → record →
 * release sequence the worker uses, so every entry point enforces the agent's
 * tokenBudgetDay / tokenBudgetMonth.
 *
 * It also provides a per-run token cap (RunTokenCap) so a single tool loop
 * can't burn an unbounded number of tokens between budget checks.
 */

import { prisma } from './db'
import {
  acquireBudgetLock,
  releaseBudgetLock,
  checkAgentBudget,
  reserveBudgetTokens,
  releaseBudgetReservation,
  recordTokenUsage,
} from './token-budget'

// Interactive turns are much smaller than task runs — hold less headroom.
const INTERACTIVE_RESERVATION_TOKENS =
  parseInt(process.env.BUDGET_INTERACTIVE_RESERVATION_TOKENS ?? '', 10) || 10_000

const LOCK_RETRIES = 5
const LOCK_RETRY_MS = 200

export type BudgetDenied = { allowed: false; reason: string }

export interface BudgetedRun {
  allowed: true
  /** Record real spend and release the reservation. Safe to call more than once. */
  finish(inputTokens: number, outputTokens: number, modelId?: string): Promise<void>
}

/**
 * Start a budgeted run for an agent. With no agentId there is no per-agent
 * budget to enforce, so the run is allowed and nothing is recorded.
 */
export async function beginBudgetedRun(agentId: string | null | undefined): Promise<BudgetedRun | BudgetDenied> {
  if (!agentId) {
    return { allowed: true, finish: async () => {} }
  }

  // The lock is only held for the check+reserve pair (milliseconds), so a short
  // retry is enough; an interactive reply shouldn't be dropped for contention.
  let lockToken: string | null = null
  for (let i = 0; i < LOCK_RETRIES && lockToken === null; i++) {
    lockToken = await acquireBudgetLock(agentId)
    if (lockToken === null) await new Promise(r => setTimeout(r, LOCK_RETRY_MS))
  }
  if (lockToken === null) {
    return { allowed: false, reason: 'Budget check is busy for this agent — try again in a moment.' }
  }

  let reserved = 0
  let check: { allowed: boolean; reason?: string }
  try {
    check = await checkAgentBudget(agentId)
    if (check.allowed) reserved = await reserveBudgetTokens(agentId, INTERACTIVE_RESERVATION_TOKENS)
  } finally {
    await releaseBudgetLock(agentId, lockToken)
  }
  if (!check.allowed) return { allowed: false, reason: check.reason ?? 'Token budget exceeded' }

  let finished = false
  return {
    allowed: true,
    async finish(inputTokens, outputTokens, modelId) {
      if (finished) return
      finished = true
      try {
        await recordTokenUsage(agentId, null, inputTokens, outputTokens, modelId)
      } catch (e) {
        console.error(`[llm-budget] recordTokenUsage failed for agent ${agentId}:`, e instanceof Error ? e.message : e)
      } finally {
        await releaseBudgetReservation(agentId, reserved).catch(() => {})
      }
    },
  }
}

/**
 * Run `fn` under the agent's budget. `fn` reports the tokens it used; they are
 * recorded even if it throws partway (pass what was used via `usage`).
 */
export async function withBudget<T>(
  agentId: string | null | undefined,
  fn: (usage: { input: number; output: number; modelId?: string }) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const run = await beginBudgetedRun(agentId)
  if (!run.allowed) return { ok: false, reason: run.reason }
  const usage: { input: number; output: number; modelId?: string } = { input: 0, output: 0 }
  try {
    return { ok: true, value: await fn(usage) }
  } finally {
    await run.finish(usage.input, usage.output, usage.modelId)
  }
}

// ── Per-run token cap ─────────────────────────────────────────────────────────

export const DEFAULT_RUN_TOKEN_CAP = 400_000
const RUN_CAP_SETTING = 'agent.run.maxTokens'

let cachedCap: { value: number; at: number } | null = null

/** Max tokens (input + output) a single interactive tool loop may consume. */
export async function getRunTokenCap(): Promise<number> {
  if (cachedCap && Date.now() - cachedCap.at < 60_000) return cachedCap.value
  let value = DEFAULT_RUN_TOKEN_CAP
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: RUN_CAP_SETTING } })
    const parsed = parseInt(String(setting?.value ?? ''), 10)
    if (parsed > 0) value = parsed
  } catch { /* keep default */ }
  cachedCap = { value, at: Date.now() }
  return value
}

/** Tracks cumulative tokens for one run and reports when the cap is hit. */
export class RunTokenCap {
  used = 0
  constructor(readonly limit: number) {}
  add(tokens: number): void { this.used += Math.max(0, tokens || 0) }
  get exceeded(): boolean { return this.used >= this.limit }
  get message(): string {
    return `Stopped: this run reached its token cap (${this.used.toLocaleString()} / ${this.limit.toLocaleString()} tokens). Ask again with a narrower request, or an admin can raise agent.run.maxTokens.`
  }
}
