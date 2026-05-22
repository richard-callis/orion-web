import { describe, it, expect } from 'vitest'
import { DEFAULT_POLICIES } from './seed-action-policies'

/**
 * Tier matrix correctness tests.
 *
 * These tests guard the default ActionPolicy tier matrix in
 * `seed-action-policies.ts`, which is security-critical: it controls what
 * actions auto-execute vs require human approval. The matrix must match
 * SIEM_PLAN.md "Default tier matrix" exactly.
 *
 * Special focus: the `firewall_block` override must escalate for *large*
 * subnets (CIDR prefix <= /24), not small ones — a /16 covers 65K addresses
 * and is the dangerous case, not a /28.
 */
describe('Default tier matrix (seed-action-policies)', () => {
  describe('Plan: byte-for-byte tier matrix rows', () => {
    it.each([
      ['crowdsec_decision_create', 'auto'],
      ['crowdsec_decision_delete', 'auto'],
      ['wazuh_active_response', 'approve'],
      ['firewall_block', 'approve'],
      ['investigate', 'auto'],
      ['incident_close', 'notify'],
      ['suppression_add', 'approve'],
      ['__destructive__', 'escalate'],
      ['__panic_mode__', 'auto'],
    ])('action %s has defaultTier %s', (actionType, defaultTier) => {
      const row = DEFAULT_POLICIES.find(p => p.actionType === actionType)
      expect(row, `missing matrix row for ${actionType}`).toBeDefined()
      expect(row!.defaultTier).toBe(defaultTier)
    })

    it('panic_mode row is flagged isPanicMode=true', () => {
      const row = DEFAULT_POLICIES.find(p => p.actionType === '__panic_mode__')
      expect(row?.isPanicMode).toBe(true)
    })

    it('no row is silently set to auto unless the plan lists it as auto', () => {
      const planAuto = new Set([
        'crowdsec_decision_create',
        'crowdsec_decision_delete',
        'investigate',
        '__panic_mode__',
      ])
      for (const row of DEFAULT_POLICIES) {
        if (row.defaultTier === 'auto') {
          expect(planAuto.has(row.actionType)).toBe(true)
        }
      }
    })
  })

  describe('firewall_block override (BLOCK-1 regression guard)', () => {
    const firewall = DEFAULT_POLICIES.find(p => p.actionType === 'firewall_block')!
    const patterns = (firewall.targetPatterns ?? []) as Array<{
      pattern: string
      tier: string
      operator: string
    }>

    it('exists with at least one escalation override', () => {
      expect(firewall).toBeDefined()
      expect(patterns.length).toBeGreaterThan(0)
    })

    it('does NOT escalate /25-/30 (small subnets — plan says these should NOT escalate)', () => {
      const smallEscalations = patterns.filter(p =>
        /^\/(25|26|27|28|29|30|31|32)$/.test(p.pattern) && p.tier === 'escalate' && p.operator === 'subnet',
      )
      expect(
        smallEscalations,
        'BLOCK-1 regression: small subnets like /25-/30 must not be the escalation triggers — they cover fewer addresses than /24, not more',
      ).toEqual([])
    })

    it('escalates large subnets (CIDR prefix <= /24, i.e. subnets > /24 in size)', () => {
      // Either explicit /0../24 enumeration, or a prefix_lte operator with threshold 24.
      const escalatesLarge =
        patterns.some(p => p.operator === 'prefix_lte' && p.pattern === '/24' && p.tier === 'escalate') ||
        patterns.filter(p => /^\/(0|[1-9]|1\d|2[0-4])$/.test(p.pattern) && p.tier === 'escalate').length > 0

      expect(
        escalatesLarge,
        'BLOCK-1 fix: firewall_block must escalate when CIDR prefix <= /24 (large subnets)',
      ).toBe(true)
    })
  })
})
