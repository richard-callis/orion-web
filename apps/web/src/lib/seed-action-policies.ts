/**
 * ActionPolicy defaults seed — runs on startup via instrumentation.ts.
 *
 * Seeds the default tier matrix for security action policies.
 * This file is security-critical: the tier matrix controls what actions
 * are auto-executed vs human-approved. Match SIEM_PLAN.md exactly.
 *
 * Tier matrix (from SIEM_PLAN.md):
 *   crowdsec_decision_create  → auto   (approve if IP in home subnet)
 *   crowdsec_decision_delete  → auto
 *   wazuh_active_response     → approve (escalate if named-prod-*)
 *   firewall_block            → approve (escalate for subnets > /24)
 *   investigate               → auto
 *   incident_close            → notify
 *   suppression_add           → approve
 *   destructive (infra)       → escalate
 *   __panic_mode__            → auto (disabled by default)
 */

import { prisma } from './db'

interface ActionPolicyDef {
  actionType: string
  defaultTier: string
  targetPatterns: unknown | null
  isPanicMode?: boolean
}

const DEFAULT_POLICIES: ActionPolicyDef[] = [
  {
    actionType: 'crowdsec_decision_create',
    defaultTier: 'auto',
    targetPatterns: [
      { pattern: '10.0.0.0/8', tier: 'approve', operator: 'subnet' as const },
      { pattern: '172.16.0.0/12', tier: 'approve', operator: 'subnet' as const },
      { pattern: '192.168.0.0/16', tier: 'approve', operator: 'subnet' as const },
    ],
  },
  {
    actionType: 'crowdsec_decision_delete',
    defaultTier: 'auto',
    targetPatterns: null,
  },
  {
    actionType: 'wazuh_active_response',
    defaultTier: 'approve',
    targetPatterns: [
      { pattern: 'named-prod-*', tier: 'escalate', operator: 'strict' as const },
    ],
  },
  {
    actionType: 'firewall_block',
    defaultTier: 'approve',
    targetPatterns: [
      { pattern: '/25', tier: 'escalate', operator: 'subnet' as const },
      { pattern: '/26', tier: 'escalate', operator: 'subnet' as const },
      { pattern: '/27', tier: 'escalate', operator: 'subnet' as const },
      { pattern: '/28', tier: 'escalate', operator: 'subnet' as const },
      { pattern: '/29', tier: 'escalate', operator: 'subnet' as const },
      { pattern: '/30', tier: 'escalate', operator: 'subnet' as const },
    ],
  },
  {
    actionType: 'investigate',
    defaultTier: 'auto',
    targetPatterns: null,
  },
  {
    actionType: 'incident_close',
    defaultTier: 'notify',
    targetPatterns: null,
  },
  {
    actionType: 'suppression_add',
    defaultTier: 'approve',
    targetPatterns: null,
  },
  {
    actionType: '__destructive__',
    defaultTier: 'escalate',
    targetPatterns: null,
  },
  {
    actionType: '__panic_mode__',
    defaultTier: 'auto',
    targetPatterns: null,
    isPanicMode: true,
  },
]

/**
 * Seed default action policies. Runs idempotently — skips existing rows.
 */
export async function ensureActionPolicies(): Promise<void> {
  try {
    for (const def of DEFAULT_POLICIES) {
      await prisma.actionPolicy.upsert({
        where: { actionType: def.actionType },
        update: {},
        create: {
          actionType:     def.actionType,
          defaultTier:    def.defaultTier,
          targetPatterns: def.targetPatterns,
          updatedBy:      'system',
        },
      })
      console.log(`[seed] ActionPolicy: ${def.actionType} → ${def.defaultTier}`)
    }
  } catch (err) {
    console.error('[seed] Failed to seed action policies:', err instanceof Error ? err.message : err)
  }
}
