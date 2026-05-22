import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decide, execute } from './action-service'
import { type ActionDecision } from './types'

// Mock Prisma — we only care about tier resolution, not DB internals
vi.mock('@/lib/db', () => ({
  prisma: {
    actionPolicy: {
      findUnique: vi.fn(),
    },
    actionAudit: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1', status: 'denied' }),
      update: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  },
}))

import { prisma } from '@/lib/db'

const mockPolicy = (actionType: string, defaultTier: string, targetPatterns: unknown = null) => {
  vi.mocked(prisma.actionPolicy.findUnique).mockResolvedValue({
    id: 'policy-1',
    actionType,
    defaultTier,
    targetPatterns,
    updatedBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any)
}

const mockNoPolicy = () => {
  vi.mocked(prisma.actionPolicy.findUnique).mockResolvedValue(null)
}

const makeRequest = (actionType: string, target: string) => ({
  actionType,
  target,
  reason: 'test',
})

describe('decide() — tier resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('crowdsec_decision_create', () => {
    it('defaults to auto tier', async () => {
      mockPolicy('crowdsec_decision_create', 'auto')
      const decision = await decide(makeRequest('crowdsec_decision_create', '1.2.3.4'), false)
      expect(decision.tier).toBe('auto')
    })

    it('approves home subnet IPs', async () => {
      mockPolicy('crowdsec_decision_create', 'auto', [
        { pattern: '10.0.0.0/8', tier: 'approve', operator: 'subnet' },
        { pattern: '172.16.0.0/12', tier: 'approve', operator: 'subnet' },
        { pattern: '192.168.0.0/16', tier: 'approve', operator: 'subnet' },
      ])
      expect((await decide(makeRequest('crowdsec_decision_create', '10.1.2.3'), false)).tier).toBe('approve')
      expect((await decide(makeRequest('crowdsec_decision_create', '172.16.5.10'), false)).tier).toBe('approve')
      expect((await decide(makeRequest('crowdsec_decision_create', '192.168.1.100'), false)).tier).toBe('approve')
    })
  })

  // Note (SIEM Review B6 / PR #414 fix): the prior describe block contained a
  // test asserting `crowdsec_decision_delete` should `escalate` "because it
  // contains delete". That test codified PR #410's substring-heuristic bug.
  // The correct expectation — per the SIEM_PLAN.md default tier matrix — is
  // that crowdsec_decision_delete is `auto`. Coverage of the correct behavior
  // lives in PR #410's test suite (which also lands the heuristic fix); the
  // mis-asserting test has been removed from this file.
  describe('non-destructive action sanity', () => {
    it('is auto when isDestructiveAction check is bypassed', async () => {
      // Test default tier without destructive override
      mockPolicy('some_other_action', 'auto')
      const decision = await decide(makeRequest('some_other_action', 'target'), false)
      expect(decision.tier).toBe('auto')
    })
  })

  describe('wazuh_active_response', () => {
    it('defaults to approve tier', async () => {
      mockPolicy('wazuh_active_response', 'approve')
      const decision = await decide(makeRequest('wazuh_active_response', 'staging-web'), false)
      expect(decision.tier).toBe('approve')
    })

    it('escalates for named-prod-* targets', async () => {
      mockPolicy('wazuh_active_response', 'approve', [
        { pattern: 'named-prod-*', tier: 'escalate', operator: 'strict' },
      ])
      expect((await decide(makeRequest('wazuh_active_response', 'named-prod-web'), false)).tier).toBe('escalate')
      expect((await decide(makeRequest('wazuh_active_response', 'staging-web'), false)).tier).toBe('approve')
    })
  })

  describe('firewall_block', () => {
    it('defaults to approve tier', async () => {
      mockPolicy('firewall_block', 'approve')
      const decision = await decide(makeRequest('firewall_block', '10.0.0.0/24'), false)
      expect(decision.tier).toBe('approve')
    })

    it('matches CIDR target patterns (specific before broad)', async () => {
      mockPolicy('firewall_block', 'approve', [
        { pattern: '10.2.2.9', tier: 'escalate', operator: 'strict' },
        { pattern: '10.0.0.0/8', tier: 'approve', operator: 'subnet' },
      ])
      expect((await decide(makeRequest('firewall_block', '10.2.2.9'), false)).tier).toBe('escalate')
      expect((await decide(makeRequest('firewall_block', '10.5.3.1'), false)).tier).toBe('approve')
      expect((await decide(makeRequest('firewall_block', '8.8.8.8'), false)).tier).toBe('approve')
    })
  })

  describe('investigate', () => {
    it('defaults to auto tier', async () => {
      mockPolicy('investigate', 'auto')
      const decision = await decide(makeRequest('investigate', '*'), false)
      expect(decision.tier).toBe('auto')
    })
  })

  describe('incident_close', () => {
    it('defaults to notify tier', async () => {
      mockPolicy('incident_close', 'notify')
      const decision = await decide(makeRequest('incident_close', 'inc-1'), false)
      expect(decision.tier).toBe('notify')
    })
  })

  describe('suppression_add', () => {
    it('defaults to approve tier', async () => {
      mockPolicy('suppression_add', 'approve')
      const decision = await decide(makeRequest('suppression_add', '1.2.3.4'), false)
      expect(decision.tier).toBe('approve')
    })
  })

  describe('destructive actions', () => {
    it('always escalates destructive actions', async () => {
      mockPolicy('delete', 'auto')
      const decision = await decide(makeRequest('delete', 'resource-1'), false)
      expect(decision.tier).toBe('escalate')
    })
  })

  describe('no policy found', () => {
    it('defaults to approve (never auto)', async () => {
      mockNoPolicy()
      const decision = await decide(makeRequest('unknown_action', '*'), false)
      expect(decision.tier).toBe('approve')
    })
  })

  describe('panic mode', () => {
    it('downgrades auto to approve', async () => {
      mockPolicy('crowdsec_decision_create', 'auto')
      const decision = await decide(makeRequest('crowdsec_decision_create', '1.2.3.4'), true)
      expect(decision.tier).toBe('approve')
    })

    it('downgrades notify to approve', async () => {
      mockPolicy('incident_close', 'notify')
      const decision = await decide(makeRequest('incident_close', 'inc-1'), true)
      expect(decision.tier).toBe('approve')
    })

    it('does NOT change approve or escalate', async () => {
      mockPolicy('firewall_block', 'approve')
      expect((await decide(makeRequest('firewall_block', '10.0.0.0/24'), true)).tier).toBe('approve')
    })
  })

  describe('wildcard pattern matching', () => {
    it('matches wildcard patterns', async () => {
      mockPolicy('test_action', 'auto', [
        { pattern: 'prod-*', tier: 'escalate', operator: 'strict' },
      ])
      expect((await decide(makeRequest('test_action', 'prod-web'), false)).tier).toBe('escalate')
      expect((await decide(makeRequest('test_action', 'staging-web'), false)).tier).toBe('auto')
    })

    it('matches literal patterns exactly', async () => {
      mockPolicy('test_action', 'auto', [
        { pattern: 'exact-target', tier: 'escalate', operator: 'strict' },
      ])
      expect((await decide(makeRequest('test_action', 'exact-target'), false)).tier).toBe('escalate')
      expect((await decide(makeRequest('test_action', 'exact-target-extra'), false)).tier).toBe('auto')
    })
  })
})

describe('execute()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto tier executes immediately', async () => {
    mockPolicy('crowdsec_decision_create', 'auto')
    const decision = await decide(makeRequest('crowdsec_decision_create', '1.2.3.4'), false)

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, result: 'Blocked 1.2.3.4' })
    const result = await execute(makeRequest('crowdsec_decision_create', '1.2.3.4'), decision, mockExecutor)

    expect(result.status).toBe('succeeded')
    expect(mockExecutor).toHaveBeenCalledTimes(1)
  })

  // The prior "approve tier without approval stays denied" test asserted
  // result.status === 'denied' for an awaiting-approval row, codifying the
  // PR #410 B3 conflation of 'pending' and 'denied'. Removed; the corrected
  // behavior (status='pending' until the operator decides) is covered by
  // PR #410's test suite once that branch lands.

  it('approve tier with approvedBy executes', async () => {
    mockPolicy('firewall_block', 'approve')
    const decision: ActionDecision = {
      actionType: 'firewall_block',
      target: '10.0.0.0/24',
      tier: 'approve',
      approvedBy: 'operator',
      incidentId: null,
    }

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, result: 'Blocked' })
    const result = await execute(makeRequest('firewall_block', '10.0.0.0/24'), decision, mockExecutor)

    expect(result.status).toBe('succeeded')
    expect(mockExecutor).toHaveBeenCalledTimes(1)
  })

  it('notify tier does not execute', async () => {
    mockPolicy('incident_close', 'notify')
    const decision = await decide(makeRequest('incident_close', 'inc-1'), false)

    const mockExecutor = vi.fn()
    const result = await execute(makeRequest('incident_close', 'inc-1'), decision, mockExecutor)

    expect(result.status).toBe('succeeded')
    expect(mockExecutor).not.toHaveBeenCalled()
  })

  it('executor failure returns failed status', async () => {
    mockPolicy('crowdsec_decision_create', 'auto')
    const decision = await decide(makeRequest('crowdsec_decision_create', '1.2.3.4'), false)

    const mockExecutor = vi.fn().mockRejectedValue(new Error('API error'))
    const result = await execute(makeRequest('crowdsec_decision_create', '1.2.3.4'), decision, mockExecutor)

    expect(result.status).toBe('failed')
    expect(result.result).toContain('API error')
  })
})
