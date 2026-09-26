import { describe, it, expect, vi, beforeEach } from 'vitest'

const tb = vi.hoisted(() => ({
  acquireBudgetLock:        vi.fn(),
  releaseBudgetLock:        vi.fn(),
  checkAgentBudget:         vi.fn(),
  reserveBudgetTokens:      vi.fn(),
  releaseBudgetReservation: vi.fn(),
  recordTokenUsage:         vi.fn(),
}))
const db = vi.hoisted(() => ({ systemSetting: { findUnique: vi.fn() } }))

vi.mock('./token-budget', () => tb)
vi.mock('./db', () => ({ prisma: db }))

import { beginBudgetedRun, withBudget, RunTokenCap } from './llm-budget'

beforeEach(() => {
  vi.clearAllMocks()
  tb.acquireBudgetLock.mockResolvedValue('lock-token')
  tb.releaseBudgetLock.mockResolvedValue(undefined)
  tb.checkAgentBudget.mockResolvedValue({ allowed: true })
  tb.reserveBudgetTokens.mockResolvedValue(10_000)
  tb.releaseBudgetReservation.mockResolvedValue(undefined)
  tb.recordTokenUsage.mockResolvedValue(undefined)
})

describe('beginBudgetedRun', () => {
  it('denies when the agent is over budget and releases the lock without reserving', async () => {
    tb.checkAgentBudget.mockResolvedValue({ allowed: false, reason: 'Daily token budget exceeded' })
    const run = await beginBudgetedRun('agent-1')
    expect(run.allowed).toBe(false)
    expect(tb.reserveBudgetTokens).not.toHaveBeenCalled()
    expect(tb.releaseBudgetLock).toHaveBeenCalledWith('agent-1', 'lock-token')
  })

  it('reserves, then records usage and releases the reservation exactly once', async () => {
    const run = await beginBudgetedRun('agent-1')
    expect(run.allowed).toBe(true)
    if (!run.allowed) return
    await run.finish(120, 30, 'ext:abc')
    await run.finish(999, 999)  // idempotent
    expect(tb.recordTokenUsage).toHaveBeenCalledOnce()
    expect(tb.recordTokenUsage).toHaveBeenCalledWith('agent-1', null, 120, 30, 'ext:abc')
    expect(tb.releaseBudgetReservation).toHaveBeenCalledWith('agent-1', 10_000)
  })

  it('allows and records nothing when there is no agent', async () => {
    const run = await beginBudgetedRun(undefined)
    expect(run.allowed).toBe(true)
    if (run.allowed) await run.finish(1, 1)
    expect(tb.checkAgentBudget).not.toHaveBeenCalled()
    expect(tb.recordTokenUsage).not.toHaveBeenCalled()
  })
})

describe('withBudget', () => {
  it('records the usage reported by fn even when fn throws', async () => {
    await expect(withBudget('agent-1', async usage => {
      usage.input = 50
      usage.output = 5
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(tb.recordTokenUsage).toHaveBeenCalledWith('agent-1', null, 50, 5, undefined)
  })

  it('returns ok:false without calling fn when over budget', async () => {
    tb.checkAgentBudget.mockResolvedValue({ allowed: false, reason: 'Monthly token budget exceeded' })
    const fn = vi.fn()
    const r = await withBudget('agent-1', fn)
    expect(r).toEqual({ ok: false, reason: 'Monthly token budget exceeded' })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('RunTokenCap', () => {
  it('reports exceeded once cumulative usage reaches the limit', () => {
    const cap = new RunTokenCap(100)
    cap.add(60)
    expect(cap.exceeded).toBe(false)
    cap.add(40)
    expect(cap.exceeded).toBe(true)
    cap.add(-500)  // negative/NaN input is ignored
    expect(cap.used).toBe(100)
  })
})
