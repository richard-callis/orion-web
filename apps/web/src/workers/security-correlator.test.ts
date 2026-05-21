import { describe, it, expect, vi } from 'vitest'

// `security-correlator.ts` imports `@/lib/db` (prisma). The pure helper
// `rulesForEnvironment` doesn't touch it, but the module is loaded as a
// whole — stub the import so vitest can resolve it without next.js path
// aliasing.
vi.mock('@/lib/db', () => ({ prisma: {} }))
vi.mock('@/lib/security/rule-engine', () => ({
  correlateEvents: vi.fn(),
  recordRuleIncident: vi.fn(),
}))

import { rulesForEnvironment } from './security-correlator'

describe('rulesForEnvironment (BLOCK-1a regression — global rules included)', () => {
  it('includes per-environment rules whose environmentId matches', () => {
    const rules = [
      { environmentId: 'env-1', name: 'a' },
      { environmentId: 'env-2', name: 'b' },
    ]
    const result = rulesForEnvironment(rules, 'env-1')
    expect(result.map(r => r.name)).toEqual(['a'])
  })

  it('includes global rules (environmentId === null) for every environment', () => {
    const rules = [
      { environmentId: null, name: 'brute_force' },
      { environmentId: null, name: 'port_scan' },
      { environmentId: 'env-1', name: 'env-specific' },
    ]
    expect(rulesForEnvironment(rules, 'env-1').map(r => r.name).sort()).toEqual(
      ['brute_force', 'env-specific', 'port_scan'],
    )
    // env-2 has no specific rules but should still pick up both globals.
    expect(rulesForEnvironment(rules, 'env-2').map(r => r.name).sort()).toEqual(
      ['brute_force', 'port_scan'],
    )
  })

  it('excludes rules belonging to a different environment', () => {
    const rules = [
      { environmentId: 'env-other', name: 'foreign' },
      { environmentId: null, name: 'global' },
    ]
    const result = rulesForEnvironment(rules, 'env-1')
    expect(result.map(r => r.name)).toEqual(['global'])
  })

  it('returns empty array when no rules match', () => {
    const rules: Array<{ environmentId: string | null }> = []
    expect(rulesForEnvironment(rules, 'env-1')).toEqual([])
  })
})
