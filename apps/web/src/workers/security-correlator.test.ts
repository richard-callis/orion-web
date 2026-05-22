import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level prisma test double ─────────────────────────────────────────
//
// Earlier suites in this file only exercise the pure helper
// `rulesForEnvironment` and don't touch prisma; the worker-level suites
// added for PR #408 BLOCK-1 need a fuller stub. We define both here and let
// the existing tests pass through unchanged.

const env_findMany = vi.fn(async () => [] as unknown[])
const event_findMany = vi.fn(async () => [] as unknown[])
const event_count = vi.fn(async () => 0)
const event_updateMany = vi.fn(async () => ({ count: 0 }))
const incident_findMany = vi.fn(async () => [] as unknown[])
const incident_create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'inc-' + Math.random(),
  ...args.data,
}))
const rule_findMany = vi.fn(async () => [] as unknown[])
const sourceHealth_findMany = vi.fn(async () => [] as unknown[])
const sourceHealth_update = vi.fn(async () => ({}))

vi.mock('@/lib/db', () => ({
  prisma: {
    environment: { findMany: (...a: unknown[]) => env_findMany(...a) },
    securityEvent: {
      findMany: (...a: unknown[]) => event_findMany(...a),
      count: (...a: unknown[]) => event_count(...a),
      updateMany: (...a: unknown[]) => event_updateMany(...a),
      create: async (args: { data: unknown }) => args.data,
    },
    incident: {
      findMany: (...a: unknown[]) => incident_findMany(...a),
      create: (...a: unknown[]) => incident_create(a[0] as { data: Record<string, unknown> }),
    },
    correlationRule: { findMany: (...a: unknown[]) => rule_findMany(...a) },
    sourceHealth: {
      findMany: (...a: unknown[]) => sourceHealth_findMany(...a),
      update: (...a: unknown[]) => sourceHealth_update(...a),
    },
  },
}))

// rule-engine is imported by the worker; mock it so each test can inject
// the drafts that "would" come out of the engine without spinning up Postgres.
const mockDrafts: { value: Array<Record<string, unknown>> } = { value: [] }
const recordRuleIncidentMock = vi.fn()
vi.mock('@/lib/security/rule-engine', () => ({
  correlateEvents: vi.fn(async () => ({
    drafts: mockDrafts.value,
    errorCount: 0,
    erroredRules: [],
  })),
  recordRuleIncident: (...args: unknown[]) => recordRuleIncidentMock(...args),
}))

import { rulesForEnvironment, runCorrelator, GLOBAL_BUCKET_ID } from './security-correlator'

beforeEach(() => {
  env_findMany.mockClear().mockResolvedValue([])
  event_findMany.mockClear().mockResolvedValue([])
  event_count.mockClear().mockResolvedValue(0)
  event_updateMany.mockClear()
  incident_findMany.mockClear().mockResolvedValue([])
  incident_create.mockClear()
  rule_findMany.mockClear().mockResolvedValue([])
  sourceHealth_findMany.mockClear().mockResolvedValue([])
  recordRuleIncidentMock.mockClear()
  mockDrafts.value = []
})

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

describe('runCorrelator — global bucket (BLOCK-1a, PR #408)', () => {
  it('processes orphan events (environmentId=null) under the synthetic bucket', async () => {
    env_findMany.mockResolvedValue([])          // no environments need work
    event_count.mockResolvedValue(2)             // 2 orphan events
    rule_findMany.mockResolvedValue([
      { name: 'brute_force', params: { type: 'threshold' }, severity: 70, environmentId: null },
    ])
    event_findMany.mockResolvedValue([
      { id: 'e1', environmentId: null, severity: 60, source: 'crowdsec', rawEvent: {} },
      { id: 'e2', environmentId: null, severity: 60, source: 'crowdsec', rawEvent: {} },
    ])
    mockDrafts.value = [
      {
        severity: 75,
        attackerKey: '1.2.3.4',
        ruleName: 'brute_force',
        eventIds: ['e1', 'e2'],
        environmentId: GLOBAL_BUCKET_ID,
      },
    ]

    const results = await runCorrelator()
    const globalResult = results.find(r => r.envId === GLOBAL_BUCKET_ID)
    expect(globalResult).toBeDefined()
    expect(globalResult?.eventsProcessed).toBe(2)
    expect(globalResult?.incidentsCreated).toBe(1)

    // The Incident must be written with environmentId=null (NOT the
    // synthetic sentinel) so the FK to Environment stays valid.
    const createArgs = incident_create.mock.calls[0]?.[0]
    expect(createArgs?.data.environmentId).toBeNull()
  })

  it('skips the global bucket entirely when no orphan events exist', async () => {
    env_findMany.mockResolvedValue([])
    event_count.mockResolvedValue(0) // no orphans
    rule_findMany.mockResolvedValue([
      { name: 'brute_force', params: { type: 'threshold' }, severity: 70, environmentId: null },
    ])
    const results = await runCorrelator()
    expect(results.find(r => r.envId === GLOBAL_BUCKET_ID)).toBeUndefined()
  })
})

describe('runCorrelator — in-run dedup (BLOCK-1b, PR #408)', () => {
  it('does NOT suppress a different rule firing on the same attacker IP', async () => {
    env_findMany.mockResolvedValue([{ id: 'env-1' }])
    event_count.mockResolvedValue(0)             // no orphans
    rule_findMany.mockResolvedValue([
      { name: 'brute_force', params: { type: 'threshold' }, severity: 70, environmentId: null },
      { name: 'port_scan',   params: { type: 'pattern'   }, severity: 50, environmentId: null },
    ])
    event_findMany.mockResolvedValue([
      { id: 'e1', environmentId: 'env-1', severity: 60, source: 'wazuh', rawEvent: {} },
    ])
    // An open brute-force incident on 1.2.3.4 already exists.
    incident_findMany.mockResolvedValue([
      { id: 'inc-existing', attackerKey: '1.2.3.4' },
    ])
    // Engine outputs two drafts on the SAME attacker IP for DIFFERENT rules.
    mockDrafts.value = [
      { severity: 70, attackerKey: '1.2.3.4', ruleName: 'brute_force', eventIds: ['e1'], environmentId: 'env-1' },
      { severity: 55, attackerKey: '1.2.3.4', ruleName: 'port_scan',   eventIds: ['e1'], environmentId: 'env-1' },
    ]

    const results = await runCorrelator()
    const envResult = results.find(r => r.envId === 'env-1')
    // Both drafts must persist — the open brute-force incident must NOT
    // suppress the port-scan draft on the same attacker. Previously the
    // 1-tuple vs 2-tuple mismatch caused both drafts to be dropped.
    expect(envResult?.incidentsCreated).toBe(2)
    expect(incident_create).toHaveBeenCalledTimes(2)
  })

  it('does suppress a duplicate draft for the SAME rule on the SAME attacker within a run', async () => {
    env_findMany.mockResolvedValue([{ id: 'env-1' }])
    event_count.mockResolvedValue(0)
    rule_findMany.mockResolvedValue([
      { name: 'brute_force', params: { type: 'threshold' }, severity: 70, environmentId: null },
    ])
    event_findMany.mockResolvedValue([
      { id: 'e1', environmentId: 'env-1', severity: 60, source: 'wazuh', rawEvent: {} },
    ])
    mockDrafts.value = [
      { severity: 70, attackerKey: '1.2.3.4', ruleName: 'brute_force', eventIds: ['e1'], environmentId: 'env-1' },
      { severity: 70, attackerKey: '1.2.3.4', ruleName: 'brute_force', eventIds: ['e1'], environmentId: 'env-1' },
    ]

    const results = await runCorrelator()
    const envResult = results.find(r => r.envId === 'env-1')
    expect(envResult?.incidentsCreated).toBe(1)
  })
})
