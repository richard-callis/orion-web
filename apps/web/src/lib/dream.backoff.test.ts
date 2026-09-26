/**
 * Dream scheduler failure handling (review finding: a failing phase left its
 * lastRun unchanged, so the next delay computed to 0 and it spun in a tight
 * loop) and the combined extraction cursor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./db', () => {
  const fail = () => Promise.reject(new Error('database is down'))
  return {
    prisma: {
      systemSetting: { findUnique: vi.fn(() => Promise.resolve(null)), upsert: vi.fn(fail) },
      chatMessage:   { findMany: vi.fn(fail) },
      taskEvent:     { findMany: vi.fn(fail) },
      note:          { findMany: vi.fn(fail) },
      task:          { findMany: vi.fn(fail) },
    },
  }
})
vi.mock('./embeddings', () => ({
  embedNote: vi.fn(),
  computeSemanticEdges: vi.fn(),
  embedSkill: vi.fn(),
  hybridSearch: vi.fn(),
}))
vi.mock('./token-budget', () => ({ estimateTokens: vi.fn(() => 0) }))
vi.mock('./skill-tools', () => ({
  validateSkillContent: vi.fn(),
  validateSkillName: vi.fn(),
  validateSkillDescription: vi.fn(),
  resolveAgentPrimaryEnvironmentId: vi.fn(),
  MIN_TRIGGER_PATTERN_LEN: 3,
  MAX_TRIGGER_PATTERNS: 5,
  MAX_STEPS: 20,
  MAX_STEP_LEN: 500,
}))

import { prisma } from './db'
import { computeDreamDelay, combinedHorizon, startDream, stopDream } from './dream'

const MIN = 60_000

describe('computeDreamDelay', () => {
  const HOUR = 60 * MIN
  const now = 10 * HOUR

  it('waits out the remaining interval when the last run succeeded', () => {
    expect(computeDreamDelay(now - 30 * MIN, 2 * HOUR, 0, now)).toBe(90 * MIN)
    expect(computeDreamDelay(0, 2 * HOUR, 0, now)).toBe(0) // overdue → run now
  })

  it('backs off exponentially after failures instead of returning 0', () => {
    // lastRun never advanced (0) — this is the case that used to hot-loop.
    expect(computeDreamDelay(0, 2 * HOUR, 1, now)).toBe(5 * MIN)
    expect(computeDreamDelay(0, 2 * HOUR, 2, now)).toBe(10 * MIN)
    expect(computeDreamDelay(0, 2 * HOUR, 3, now)).toBe(20 * MIN)
  })

  it('caps the backoff at 2 hours', () => {
    expect(computeDreamDelay(0, 2 * HOUR, 10, now)).toBe(2 * HOUR)
    expect(computeDreamDelay(0, 2 * HOUR, 50, now)).toBe(2 * HOUR)
  })
})

describe('combinedHorizon', () => {
  const at = (m: number) => ({ ts: new Date(m * MIN) })

  it('is null when no source hit its limit (everything fetched is safe)', () => {
    expect(combinedHorizon([
      { rows: [at(1), at(5)], limit: 3 },
      { rows: [at(2)], limit: 2 },
    ])).toBeNull()
  })

  it('stops at the last row of a truncated source', () => {
    // messages truncated at t=3; events extend to t=9 — processing events past
    // t=3 and advancing the watermark there would skip unfetched messages.
    expect(combinedHorizon([
      { rows: [at(1), at(2), at(3)], limit: 3 },
      { rows: [at(4), at(9)], limit: 5 },
    ])).toEqual(new Date(3 * MIN))
  })

  it('uses the earliest truncation point when several sources are truncated', () => {
    expect(combinedHorizon([
      { rows: [at(1), at(7)], limit: 2 },
      { rows: [at(2), at(4)], limit: 2 },
    ])).toEqual(new Date(4 * MIN))
  })
})

describe('dream scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    stopDream()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not hot-loop when a phase keeps failing', async () => {
    const extractionReads = vi.mocked(prisma.chatMessage.findMany)
    extractionReads.mockClear()

    startDream()
    // Never-run phase is overdue → first attempt fires immediately and fails.
    await vi.advanceTimersByTimeAsync(0)
    expect(extractionReads).toHaveBeenCalledTimes(1)

    // Before the fix the retry was scheduled with delay 0 → thousands of calls.
    await vi.advanceTimersByTimeAsync(4 * MIN)
    expect(extractionReads).toHaveBeenCalledTimes(1)

    // First backoff is 5 min.
    await vi.advanceTimersByTimeAsync(1 * MIN + 1)
    expect(extractionReads).toHaveBeenCalledTimes(2)

    // Second backoff is 10 min.
    await vi.advanceTimersByTimeAsync(9 * MIN)
    expect(extractionReads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1 * MIN + 1)
    expect(extractionReads).toHaveBeenCalledTimes(3)
  })

  it('stopDream cancels pending runs', async () => {
    const extractionReads = vi.mocked(prisma.chatMessage.findMany)
    extractionReads.mockClear()
    startDream()
    await vi.advanceTimersByTimeAsync(0)
    const calls = extractionReads.mock.calls.length
    stopDream()
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN)
    expect(extractionReads).toHaveBeenCalledTimes(calls)
  })
})
