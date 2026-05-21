import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ prisma: {} }))

import { extractGroupValue } from './rule-engine'

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
