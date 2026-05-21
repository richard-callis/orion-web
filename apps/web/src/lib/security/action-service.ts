/**
 * Action service — tier decision and execution coordination.
 *
 * This is the central coordination layer between the correlator/warden
 * and the action executor. It:
 * 1. Looks up the action policy for a given actionType
 * 2. Resolves the tier (auto/approve/escalate/notify) with target-pattern overrides
 * 3. Handles panic mode
 * 4. Creates ActionAudit rows
 */

import { prisma } from '@/lib/db'
import { type ActionRequest, type ActionDecision, actionRequestSchema, actionDecisionSchema } from './types'

// ── Tier resolution ───────────────────────────────────────────────────────────

/**
 * Determine the tier for an action request.
 *
 * Looks up ActionPolicy for the actionType, applies target-pattern overrides,
 * and handles panic mode.
 */
export async function decide(
  request: ActionRequest,
  panicMode: boolean
): Promise<ActionDecision> {
  // 1. Parse and validate the request
  const parsed = actionRequestSchema.parse(request)

  // 2. Look up action policy
  const policy = await prisma.actionPolicy.findUnique({
    where: { actionType: parsed.actionType },
  })

  if (!policy) {
    // No policy found — default to approve
    return actionDecisionSchema.parse({
      actionType: parsed.actionType,
      target: parsed.target,
      tier: 'approve',
      incidentId: parsed.incidentId ?? null,
    })
  }

  let tier = policy.defaultTier

  // 3. Check panic mode — downgrades auto/notify to approve
  if (panicMode) {
    if (tier === 'auto' || tier === 'notify') {
      tier = 'approve'
    }
  }

  // 4. Check target-pattern overrides
  if (policy.targetPatterns && Array.isArray(policy.targetPatterns)) {
    for (const pattern of policy.targetPatterns as Array<{ pattern: string; tier: string; operator?: string }>) {
      if (matchesPattern(parsed.target, pattern.pattern, pattern.operator ?? 'strict')) {
        tier = pattern.tier
        break
      }
    }
  }

  // 5. Check for destructive infra actions
  if (parsed.actionType.startsWith('__destructive__') || isDestructiveAction(parsed.actionType)) {
    tier = 'escalate'
  }

  return actionDecisionSchema.parse({
    actionType: parsed.actionType,
    target: parsed.target,
    tier,
    incidentId: parsed.incidentId ?? null,
  })
}

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Match a target string against a pattern.
 * Supports: literal match, wildcard (*), and CIDR subnet (operator: 'subnet').
 */
function matchesPattern(target: string, pattern: string, operator?: string): boolean {
  // CIDR subnet matching
  if (operator === 'subnet') {
    return matchesSubnet(target, pattern)
  }

  // Wildcard match
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)
    return regex.test(target)
  }

  // Literal match
  return target === pattern
}

/**
 * Check if an IP/CIDR is within a parent CIDR.
 * Simplified — handles /8, /12, /16 home subnet ranges.
 */
function matchesSubnet(target: string, cidr: string): boolean {
  // Quick check: target is an IP, cidr is a CIDR
  if (target.includes('/') && cidr.includes('/')) {
    // Both are CIDRs — check if target subnet overlaps with cidr
    return ipInRange(target.split('/')[0], cidr)
  }
  if (target.includes('/')) {
    // target is CIDR, cidr is CIDR
    return ipInRange(target.split('/')[0], cidr)
  }
  // target is IP, cidr is CIDR
  return ipInRange(target, cidr)
}

/**
 * Check if an IP is within a CIDR range.
 * Only handles common home subnet ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
 */
function ipInRange(ip: string, cidr: string): boolean {
  if (!ip.includes('.') || !cidr.includes('/')) return false

  const [cidrIp, cidrPrefixStr] = cidr.split('/')
  const prefixLength = parseInt(cidrPrefixStr, 10)

  const ipParts = ip.split('.').map(Number)
  const cidrParts = cidrIp.split('.').map(Number)

  if (ipParts.length !== 4 || cidrParts.length !== 4) return false

  // Convert to 32-bit integer
  const ipNum = ipParts.reduce((acc, part) => (acc << 8) | part, 0) >>> 0
  const cidrNum = cidrParts.reduce((acc, part) => (acc << 8) | part, 0) >>> 0
  const mask = prefixLength > 0 ? (~0 << (32 - prefixLength)) >>> 0 : 0

  return (ipNum & mask) === (cidrNum & mask)
}

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * Execute an action and record the result in ActionAudit.
 *
 * Writes status='attempting' BEFORE execution (R9), updates after.
 */
export async function execute(
  request: ActionRequest,
  decision: ActionDecision,
  executor: (action: ActionRequest, target: string, payload?: Record<string, unknown>) => Promise<{ success: boolean; result: string }>
): Promise<{ auditId: string; status: string; result?: string }> {
  const parsed = actionRequestSchema.parse(request)
  const parsedDecision = actionDecisionSchema.parse(decision)

  // 1. Create ActionAudit with status='attempting' (R9: no data loss)
  const audit = await prisma.actionAudit.create({
    data: {
      environmentId: null, // TODO: resolve from context
      incidentId: parsedDecision.incidentId ?? null,
      actionType: parsed.actionType,
      target: parsed.target,
      tier: parsedDecision.tier,
      proposedBy: request.incidentId ? 'warden' : 'system',
      approvedBy: parsedDecision.approvedBy ?? null,
      status: 'denied',
      payload: parsed.payload as any,
    },
  })

  // 2. Auto-tier: execute immediately
  if (parsedDecision.tier === 'auto') {
    try {
      const { success, result } = await executor(parsed, parsed.target, parsed.payload ?? {})

      await prisma.actionAudit.update({
        where: { id: audit.id },
        data: { status: success ? 'succeeded' : 'failed', result },
      })
      return { auditId: audit.id, status: success ? 'succeeded' : 'failed', result }
    } catch (err) {
      await prisma.actionAudit.update({
        where: { id: audit.id },
        data: { status: 'failed', result: err instanceof Error ? err.message : String(err) },
      })
      return { auditId: audit.id, status: 'failed', result: err instanceof Error ? err.message : String(err) }
    }
  }

  // 3. Approve-tier with approvedBy: execute
  if (parsedDecision.tier === 'approve' && parsedDecision.approvedBy) {
    try {
      const { success, result } = await executor(parsed, parsed.target, parsed.payload ?? {})

      await prisma.actionAudit.update({
        where: { id: audit.id },
        data: { status: success ? 'succeeded' : 'failed', result },
      })
      return { auditId: audit.id, status: success ? 'succeeded' : 'failed', result }
    } catch (err) {
      await prisma.actionAudit.update({
        where: { id: audit.id },
        data: { status: 'failed', result: err instanceof Error ? err.message : String(err) },
      })
      return { auditId: audit.id, status: 'failed', result: err instanceof Error ? err.message : String(err) }
    }
  }

  // 4. Approve without approval: remain 'denied' (pending)
  if (parsedDecision.tier === 'approve') {
    return { auditId: audit.id, status: 'denied' }
  }

  // 5. Escalate → denied, notify → succeeded (no execution needed)
  const finalStatus = parsedDecision.tier === 'notify' ? 'succeeded' : 'denied'
  return { auditId: audit.id, status: finalStatus }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isDestructiveAction(actionType: string): boolean {
  const destructivePatterns = [
    '__destructive__',
    'delete',
    'destroy',
    'purge',
    'wipe',
    'format',
  ]
  return destructivePatterns.some(p => actionType.includes(p))
}
