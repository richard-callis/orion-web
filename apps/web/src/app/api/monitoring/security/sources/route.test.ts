/**
 * Tests for computeSourceStatus (PR #413 B3).
 *
 * Locks in success criterion #8 from SIEM_PLAN.md: the UI must distinguish
 * 'stale' from 'down'. The prior code had both branches return 'stale',
 * making 'down' unreachable for any source that had ever been seen.
 */

import { describe, it, expect } from 'vitest'
import { computeSourceStatus } from './route'

describe('computeSourceStatus', () => {
  const STALE_MS = 60_000 // 1 min for tests

  it('returns down when lastSeen is 0 (never seen)', () => {
    expect(computeSourceStatus(0, Date.now(), STALE_MS)).toBe('down')
  })

  it('returns healthy when elapsed is within staleAfterMs', () => {
    const now = 1_000_000
    expect(computeSourceStatus(now - 30_000, now, STALE_MS)).toBe('healthy')
  })

  it('returns stale when elapsed is between 1x and 2x staleAfterMs', () => {
    const now = 1_000_000
    expect(computeSourceStatus(now - 90_000, now, STALE_MS)).toBe('stale')
  })

  it('returns down when elapsed exceeds 2x staleAfterMs (B3)', () => {
    const now = 1_000_000
    // 2.5x staleAfterMs — must be 'down', not 'stale'
    expect(computeSourceStatus(now - 150_000, now, STALE_MS)).toBe('down')
  })

  it('returns down for very-stale sources (regression: B3)', () => {
    const now = 1_000_000
    // 1 hour ago, 1 min staleAfterMs → way over 2x
    expect(computeSourceStatus(now - 3_600_000, now, STALE_MS)).toBe('down')
  })

  it('healthy at the boundary (elapsed === staleAfterMs)', () => {
    const now = 1_000_000
    expect(computeSourceStatus(now - STALE_MS, now, STALE_MS)).toBe('healthy')
  })

  it('stale right past the boundary', () => {
    const now = 1_000_000
    expect(computeSourceStatus(now - STALE_MS - 1, now, STALE_MS)).toBe('stale')
  })

  it('down right past 2x boundary', () => {
    const now = 1_000_000
    expect(computeSourceStatus(now - 2 * STALE_MS - 1, now, STALE_MS)).toBe('down')
  })
})
