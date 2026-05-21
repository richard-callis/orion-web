import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `rule-engine` calls `prisma.securityEvent.findMany` from each sub-runner.
// We stub it so we can exercise the orchestration layer without a DB.
const findManyMock = vi.fn()
vi.mock('@/lib/db', () => ({
  prisma: {
    securityEvent: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}))

import {
  extractGroupValue,
  correlateEvents,
  shouldRateLimitRule,
  recordRuleIncident,
  _resetRuleRateLimitsForTests,
  type NamedRule,
} from './rule-engine'

describe('extractGroupValue (BLOCK-1b regression — brute-force groups by attacker IP)', () => {
  describe('top-level column access', () => {
    it('returns the value of a top-level column', () => {
      const event = { source: 'crowdsec', severity: 70 }
      expect(extractGroupValue(event, 'source')).toBe('crowdsec')
    })

    it('coerces non-string values to string', () => {
      const event = { severity: 70 }
      expect(extractGroupValue(event, 'severity')).toBe('70')
    })

    it('returns null for missing top-level field', () => {
      const event = { source: 'crowdsec' }
      expect(extractGroupValue(event, 'nonexistent')).toBeNull()
    })
  })

  describe('rawEvent JSON path (the fix)', () => {
    it('extracts a one-level rawEvent.<field> path', () => {
      const event = {
        source: 'crowdsec',
        rawEvent: { srcip: '203.0.113.7', user: 'root' },
      }
      expect(extractGroupValue(event, 'rawEvent.srcip')).toBe('203.0.113.7')
    })

    it('extracts a multi-level dot path', () => {
      const event = {
        rawEvent: { alert: { srcip: '198.51.100.5', dest: 'host-a' } },
      }
      expect(extractGroupValue(event, 'rawEvent.alert.srcip')).toBe('198.51.100.5')
    })

    it('returns null when an intermediate segment is missing', () => {
      const event = { rawEvent: { srcip: '1.2.3.4' } }
      expect(extractGroupValue(event, 'rawEvent.alert.srcip')).toBeNull()
    })

    it('returns null when the leaf is missing', () => {
      const event = { rawEvent: { other: 'value' } }
      expect(extractGroupValue(event, 'rawEvent.srcip')).toBeNull()
    })

    it('returns null when an intermediate segment is not an object', () => {
      const event = { rawEvent: 'not-an-object' }
      expect(extractGroupValue(event, 'rawEvent.srcip')).toBeNull()
    })
  })

  describe('groupBy semantics for brute-force rule', () => {
    // Brute-force scenario: 5 events from same attacker IP, two ingestion
    // sources. The OLD buggy seed grouped by `source` — bucketing 3 CrowdSec
    // events together and 2 Wazuh events separately, missing the 5-from-same-IP
    // threshold. The FIX groups by `rawEvent.srcip` — all 5 cluster correctly.
    const events = [
      { source: 'crowdsec', rawEvent: { srcip: '203.0.113.7' } },
      { source: 'crowdsec', rawEvent: { srcip: '203.0.113.7' } },
      { source: 'crowdsec', rawEvent: { srcip: '203.0.113.7' } },
      { source: 'wazuh',    rawEvent: { srcip: '203.0.113.7' } },
      { source: 'wazuh',    rawEvent: { srcip: '203.0.113.7' } },
      { source: 'crowdsec', rawEvent: { srcip: '198.51.100.9' } }, // different attacker
    ]

    function groupBy(field: string): Map<string, number> {
      const counts = new Map<string, number>()
      for (const e of events) {
        const key = extractGroupValue(e, field) ?? 'unknown'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return counts
    }

    it('buggy seed: grouping by `source` over-aggregates across attackers', () => {
      const counts = groupBy('source')
      expect(counts.get('crowdsec')).toBe(4)
      expect(counts.get('wazuh')).toBe(2)
    })

    it('fixed seed: grouping by `rawEvent.srcip` clusters by attacker IP', () => {
      const counts = groupBy('rawEvent.srcip')
      expect(counts.get('203.0.113.7')).toBe(5) // ≥5 threshold met
      expect(counts.get('198.51.100.9')).toBe(1)
    })
  })
})

describe('correlateEvents — MAJOR-4 (silent rule errors are now logged + counted)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    findManyMock.mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('logs the rule name and error when a rule throws, and keeps running others', async () => {
    // First call (failing rule) — throw. Second call (healthy rule) — return [].
    findManyMock
      .mockRejectedValueOnce(new Error('boom: bad regex'))
      .mockResolvedValueOnce([])

    const rules: NamedRule[] = [
      {
        name: 'broken_pattern',
        params: { type: 'pattern', regex: '(', field: 'title', window: 60 },
      },
      {
        name: 'healthy_pattern',
        params: { type: 'pattern', regex: 'foo', field: 'title', window: 60 },
      },
    ]

    const result = await correlateEvents('env-1', new Date(), rules)
    expect(result.errorCount).toBe(1)
    expect(result.erroredRules).toEqual(['broken_pattern'])
    // Healthy rule still ran (findMany called twice — once per rule).
    expect(findManyMock).toHaveBeenCalledTimes(2)
    // Error log mentions the rule name and env id.
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('broken_pattern')
    expect(logged).toContain('env-1')
  })

  it('reports zero errors and does not log when every rule succeeds', async () => {
    findManyMock.mockResolvedValue([])
    const result = await correlateEvents('env-1', new Date(), [
      {
        name: 'rule_a',
        params: { type: 'pattern', regex: 'x', field: 'title', window: 60 },
      },
    ])
    expect(result.errorCount).toBe(0)
    expect(result.erroredRules).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still accepts the legacy bare-RuleParams[] shape (back-compat)', async () => {
    findManyMock.mockResolvedValue([])
    const result = await correlateEvents('env-1', new Date(), [
      { type: 'pattern', regex: 'x', field: 'title', window: 60 },
    ])
    // No rule name supplied → synthetic unnamed_pattern; no error path hit.
    expect(result.errorCount).toBe(0)
  })
})

describe('per-rule rate limit — MAJOR-2 (R4: poison-rule cap)', () => {
  const originalMax = process.env.SIEM_RULE_RATE_LIMIT_MAX
  const originalWindow = process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS

  beforeEach(() => {
    findManyMock.mockReset()
    _resetRuleRateLimitsForTests()
  })
  afterEach(() => {
    if (originalMax === undefined) delete process.env.SIEM_RULE_RATE_LIMIT_MAX
    else process.env.SIEM_RULE_RATE_LIMIT_MAX = originalMax
    if (originalWindow === undefined) delete process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS
    else process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS = originalWindow
    _resetRuleRateLimitsForTests()
  })

  it('does not rate-limit a rule that has never produced an incident', () => {
    expect(shouldRateLimitRule('env-1', 'brute_force')).toBe(false)
  })

  it('rate-limits a rule once it exceeds the per-window cap', () => {
    process.env.SIEM_RULE_RATE_LIMIT_MAX = '3'
    process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS = '60000'
    const t0 = 1_000_000

    recordRuleIncident('env-1', 'brute_force', t0)
    recordRuleIncident('env-1', 'brute_force', t0 + 100)
    expect(shouldRateLimitRule('env-1', 'brute_force', t0 + 200)).toBe(false)

    recordRuleIncident('env-1', 'brute_force', t0 + 300)
    // Now at 3 incidents within a 60s window → next check trips the cap.
    expect(shouldRateLimitRule('env-1', 'brute_force', t0 + 400)).toBe(true)
  })

  it('isolates rate-limit buckets per (env, rule) pair', () => {
    process.env.SIEM_RULE_RATE_LIMIT_MAX = '2'
    process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS = '60000'
    const t0 = 1_000_000

    recordRuleIncident('env-1', 'brute_force', t0)
    recordRuleIncident('env-1', 'brute_force', t0 + 100)
    expect(shouldRateLimitRule('env-1', 'brute_force', t0 + 200)).toBe(true)

    // Different rule on the same env — fresh bucket.
    expect(shouldRateLimitRule('env-1', 'port_scan', t0 + 200)).toBe(false)
    // Same rule on a different env — fresh bucket.
    expect(shouldRateLimitRule('env-2', 'brute_force', t0 + 200)).toBe(false)
  })

  it('auto-resets the bucket once the window elapses', () => {
    process.env.SIEM_RULE_RATE_LIMIT_MAX = '1'
    process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS = '60000'
    const t0 = 1_000_000

    recordRuleIncident('env-1', 'noisy', t0)
    expect(shouldRateLimitRule('env-1', 'noisy', t0 + 1000)).toBe(true)
    // 61s later — window has elapsed; bucket clears on the next check.
    expect(shouldRateLimitRule('env-1', 'noisy', t0 + 61_000)).toBe(false)
  })

  it('correlateEvents skips a rule already over its cap and logs a warning', async () => {
    process.env.SIEM_RULE_RATE_LIMIT_MAX = '1'
    process.env.SIEM_RULE_RATE_LIMIT_WINDOW_MS = '60000'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    findManyMock.mockResolvedValue([])

    // Pre-load the bucket so the rule is over its cap before the call.
    recordRuleIncident('env-1', 'poison_rule')
    recordRuleIncident('env-1', 'poison_rule')

    const rules: NamedRule[] = [
      {
        name: 'poison_rule',
        params: { type: 'pattern', regex: 'x', field: 'title', window: 60 },
      },
      {
        name: 'healthy_rule',
        params: { type: 'pattern', regex: 'y', field: 'title', window: 60 },
      },
    ]

    const result = await correlateEvents('env-1', new Date(), rules)
    // The poison rule was skipped (no findMany call for it); the healthy
    // rule still ran (exactly one findMany call).
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(result.errorCount).toBe(0)
    const warned = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(warned).toContain('poison_rule')
    expect(warned).toContain('rate-limited')
    warnSpy.mockRestore()
  })
})
