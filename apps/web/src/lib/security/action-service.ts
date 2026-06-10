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
import { signDecisionToken } from './decision-token'
import { type ActionRequest, type ActionDecision, actionRequestSchema, actionDecisionSchema } from './types'

// ── Gateway executor ──────────────────────────────────────────────────────────

// Known error prefixes returned by gateway write tools when the upstream
// source is unavailable or misconfigured. Used to detect soft failures that
// arrive as HTTP 200 with an error body (the gateway always returns 200 for
// tool results, using the body to signal failure).
const GATEWAY_ERROR_PREFIXES = [
  '{"error"',
  'environment variable not configured',
  'decision token rejected',
  'security write tool requires',
  'crowdsec error',
  'wazuh error',
  'firewall_api',
]

function isErrorResult(result: string): boolean {
  const lower = result.toLowerCase()
  return GATEWAY_ERROR_PREFIXES.some(p => lower.includes(p.toLowerCase()))
}

/**
 * Execute a security action via the gateway's tool endpoint.
 *
 * Mints a short-lived HMAC decision token bound to the audit row, action
 * type, and target — the gateway write tools refuse calls without one.
 * The auditId is threaded through via payload.__auditId (set by execute()).
 */
/**
 * Structured error type for gateway executor results.
 * Callers (e.g. the correlator) can inspect `errorType` to route failures:
 *   'network'        — transient, safe to retry
 *   'infrastructure' — upstream 5xx, may be worth retrying after backoff
 *   'auth'           — 401/403, escalate rather than retry (bad token/config)
 *   'validation'     — 400/422, fix the call arguments rather than retrying
 *   'unknown'        — unexpected status or format
 */
export type GatewayErrorType = 'network' | 'auth' | 'validation' | 'infrastructure' | 'unknown'

export async function gatewayExecutor(
  action: ActionRequest,
  target: string,
  payload?: Record<string, unknown>,
  environmentId?: string | null,
): Promise<{ success: boolean; result: string; errorType?: GatewayErrorType }> {
  const where = {
    status: 'connected',
    gatewayUrl: { not: null },
    ...(environmentId ? { id: environmentId } : {}),
  }
  const env = await prisma.environment.findFirst({
    where,
    select: { gatewayUrl: true, gatewayToken: true },
  })

  if (!env?.gatewayUrl) {
    return { success: false, result: 'No connected gateway configured' }
  }

  let toolName = ''
  let toolArgs: Record<string, unknown> = {}

  switch (action.actionType) {
    case 'crowdsec_decision_create':
      toolName = 'crowdsec_decision_create'
      toolArgs = { ip: target, reason: payload?.reason ?? 'Blocked via ORION' }
      break
    case 'crowdsec_decision_delete':
      toolName = 'crowdsec_decision_delete'
      // Tool body reads args.ip; token check reads args.decisionId.
      // Send both so the token binding and the LAPI call both work.
      toolArgs = { ip: target, decisionId: target }
      break
    case 'wazuh_active_response':
      toolName = 'wazuh_active_response'
      toolArgs = { agent: target, command: payload?.command ?? '', args: payload?.args }
      break
    case 'firewall_block':
      toolName = 'firewall_block'
      toolArgs = { cidr: target, reason: payload?.reason ?? 'Blocked via ORION' }
      break
    case 'investigate':
      // investigate is a read action — no token required, no write tool called
      toolName = 'elk_flow_search'
      toolArgs = { size: payload?.limit ?? 20 }
      break
    default:
      return { success: false, result: `Unknown action type: ${action.actionType}` }
  }

  // Mint a decision token for write tools. The auditId is passed via payload
  // by execute() after the ActionAudit row is created.
  const auditId = typeof payload?.__auditId === 'string' ? payload.__auditId : ''
  const isWriteTool = action.actionType !== 'investigate'
  if (isWriteTool && auditId) {
    try {
      toolArgs.__decision_token = signDecisionToken({ auditId, actionType: action.actionType, target })
    } catch (err) {
      return {
        success: false,
        result: `Decision token signing failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  let res: Response
  try {
    res = await fetch(`${env.gatewayUrl}/tools/execute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.gatewayToken ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: toolName, arguments: toolArgs }),
    })
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, etc.)
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[gateway-executor] network error calling ${env.gatewayUrl}/tools/execute: ${msg}`)
    return { success: false, result: `Gateway network error: ${msg}`, errorType: 'network' }
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '')
    const truncated = rawBody.slice(0, 500)
    console.error(`[gateway-executor] HTTP ${res.status} from gateway — body: ${truncated}`)
    let errorType: GatewayErrorType
    if (res.status === 401 || res.status === 403) {
      errorType = 'auth'
    } else if (res.status === 400 || res.status === 422) {
      errorType = 'validation'
    } else if (res.status >= 500 && res.status < 600) {
      errorType = 'infrastructure'
    } else {
      errorType = 'unknown'
    }
    return { success: false, result: rawBody || `HTTP ${res.status}`, errorType }
  }

  const data = await res.json() as { result?: unknown }

  const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)

  // Gateway write tools return HTTP 200 even on soft failures (token rejected,
  // upstream unreachable, env var missing). Detect error bodies explicitly.
  if (isErrorResult(resultStr)) {
    return { success: false, result: resultStr }
  }

  return { success: true, result: resultStr }
}

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

  // 3. Check target-pattern overrides
  if (policy.targetPatterns && Array.isArray(policy.targetPatterns)) {
    for (const pattern of policy.targetPatterns as Array<{ pattern: string; tier: string; operator?: string }>) {
      if (matchesPattern(parsed.target, pattern.pattern, pattern.operator ?? 'strict')) {
        tier = pattern.tier
        break
      }
    }
  }

  // 4. Check panic mode AFTER overrides — panic must be the final transform.
  // Overrides running before panic could re-elevate a tier back to 'auto'
  // during an active emergency (B2 from Opus review 2026-06-03).
  if (panicMode) {
    if (tier === 'auto' || tier === 'notify') {
      tier = 'approve'
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
 * Supports: literal match, wildcard (*), CIDR subnet (operator: 'subnet'),
 * and prefix length comparison (operator: 'prefix_lte').
 *
 * prefix_lte: checks if the target's prefix length is <= the pattern's prefix
 * length (i.e. the target subnet is wider than or equal to the threshold).
 * Used for firewall_block /24-or-wider escalation.
 */
export function matchesPattern(target: string, pattern: string, operator?: string): boolean {
  // prefix_lte: target prefix length <= pattern prefix length (wider-or-equal)
  if (operator === 'prefix_lte') {
    return prefixLTE(target, pattern)
  }

  // CIDR subnet containment matching
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
 *
 * IPv4: full check against the provided CIDR.
 * IPv6: fail CLOSED — if the target looks like IPv6 (contains ':') and the CIDR
 *       is an IPv4 home subnet, we cannot prove the address is NOT a home
 *       address, so we return true to force the home-subnet `approve` override.
 *       This addresses R1 (locking out a legitimate home/LAN IP) for IPv6.
 */
export function ipInRange(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return false

  // IPv6 fail-closed: any IPv6 address is treated as potentially home/LAN
  // for the home-subnet override path. The home-subnet rows are 10/8, 172.16/12,
  // 192.168/16 — all IPv4 — so we can't compare numerically. The safer default
  // is to engage the override (force `approve`) rather than auto-ban.
  if (ip.includes(':')) {
    return true
  }

  if (!ip.includes('.')) return false

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

/**
 * Check if target's prefix length is <= pattern's prefix length (wider-or-equal).
 *
 * Used for firewall_block escalation: "is this subnet /24-or-wider?"
 *
 * Handles:
 * - IPv4: "10.0.0.0/8", "192.168.1.0/24", "/16" (prefix-only)
 * - IPv6: "2001:db8::/32", "fe80::/10", "::/0" (full IPv6 range)
 * - Defaults to `approve` (never `auto`) for unparseable inputs
 */
export function prefixLTE(target: string, pattern: string): boolean {
  const targetLen = extractPrefixLength(target)
  const patternLen = extractPrefixLength(pattern)

  // If either is unparseable, default to approve (safe)
  if (targetLen === null || patternLen === null) return false

  return targetLen <= patternLen
}

/**
 * Extract the prefix length from an IPv4 CIDR, IPv6 CIDR, or prefix-only string.
 *
 * Accepts: "10.0.0.0/8", "/8", "2001:db8::/32", "/32", "0.0.0.0/0"
 * Returns null for unparseable inputs.
 */
export function extractPrefixLength(s: string): number | null {
  // Strip leading slash for prefix-only notation (e.g. "/24")
  let cleaned = s
  if (cleaned.startsWith('/') && !cleaned.includes('.')) {
    const n = parseInt(cleaned.slice(1), 10)
    if (n >= 0 && n <= 128) return n
    return null
  }

  // CIDR notation — split on last '/'
  const slashIdx = cleaned.lastIndexOf('/')
  if (slashIdx === -1) return null // no prefix length

  const prefixStr = cleaned.slice(slashIdx + 1)
  const prefix = parseInt(prefixStr, 10)
  if (!Number.isFinite(prefix)) return null

  // Validate range based on address family
  const ipPart = cleaned.slice(0, slashIdx)
  if (ipPart.includes(':')) {
    // IPv6
    if (prefix >= 0 && prefix <= 128) return prefix
  } else {
    // IPv4
    if (prefix >= 0 && prefix <= 32) return prefix
  }

  return null
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
  // NOTE: `errorType` on the executor result is available for routing decisions.
  // Callers can inspect it to distinguish retryable failures (network/infrastructure)
  // from configuration errors (auth) and bad inputs (validation). The execute()
  // function surfaces it via the returned `result` string; extend the return type
  // if callers need programmatic access to errorType in the future.
  executor: (action: ActionRequest, target: string, payload?: Record<string, unknown>) => Promise<{ success: boolean; result: string; errorType?: GatewayErrorType }>
): Promise<{ auditId: string; status: string; result?: string }> {
  const parsed = actionRequestSchema.parse(request)
  const parsedDecision = actionDecisionSchema.parse(decision)

  // 1. Create ActionAudit BEFORE invoking the gateway (R9: no data loss).
  //    - auto / approved-approve     → 'attempting'  (gateway call about to fire)
  //    - approve (awaiting approval) → 'pending'      (sits in approval queue)
  //    - notify                       → 'attempting'  (no gateway call, but logged)
  //    - escalate                     → 'pending'      (operator action required)
  // 'denied' is reserved for actions the operator explicitly denied (terminal).
  const initialStatus =
    parsedDecision.tier === 'auto' ||
    (parsedDecision.tier === 'approve' && parsedDecision.approvedBy) ||
    parsedDecision.tier === 'notify'
      ? 'attempting'
      : 'pending'

  // Resolve environmentId from the linked incident when available.
  let resolvedEnvironmentId: string | null = null
  const incidentId = parsedDecision.incidentId ?? parsed.incidentId ?? null
  if (incidentId) {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
      select: { environmentId: true },
    })
    resolvedEnvironmentId = incident?.environmentId ?? null
  }

  const audit = await prisma.actionAudit.create({
    data: {
      environmentId: resolvedEnvironmentId,
      incidentId: parsedDecision.incidentId ?? null,
      actionType: parsed.actionType,
      target: parsed.target,
      tier: parsedDecision.tier,
      proposedBy: request.incidentId ? 'warden' : 'system',
      approvedBy: parsedDecision.approvedBy ?? null,
      status: initialStatus,
      payload: parsed.payload as any,
    },
  })

  // 2. Auto-tier: execute immediately
  if (parsedDecision.tier === 'auto') {
    try {
      // Thread audit.id into payload so gatewayExecutor can mint the decision token.
      const execPayload = { ...(parsed.payload ?? {}), __auditId: audit.id }
      const { success, result } = await executor(parsed, parsed.target, execPayload)

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
      // Thread audit.id into payload so gatewayExecutor can mint the decision token.
      const execPayload = { ...(parsed.payload ?? {}), __auditId: audit.id }
      const { success, result } = await executor(parsed, parsed.target, execPayload)

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

  // 4. Approve without approval: remain 'pending' (awaiting operator)
  if (parsedDecision.tier === 'approve') {
    return { auditId: audit.id, status: 'pending' }
  }

  // 5. Notify-tier: no gateway call, mark succeeded (audit-only).
  //    Escalate-tier: stays 'pending' for the human escalation path.
  if (parsedDecision.tier === 'notify') {
    await prisma.actionAudit.update({
      where: { id: audit.id },
      data: { status: 'succeeded' },
    })
    return { auditId: audit.id, status: 'succeeded' }
  }
  return { auditId: audit.id, status: 'pending' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect destructive infra actions that MUST escalate.
 *
 * IMPORTANT: this is an explicit allowlist, not a substring heuristic.
 * The previous substring match caught `crowdsec_decision_delete` (a legitimate
 * `auto`-tier unban), inverting the tier matrix. Anything that should escalate
 * must be added by name or via the `__destructive__` policy row.
 */
export function isDestructiveAction(actionType: string): boolean {
  const destructiveActions = new Set<string>([
    '__destructive__',
    'infra_destroy',
    'infra_wipe',
    'infra_format',
    'volume_purge',
    'cluster_delete',
  ])
  return destructiveActions.has(actionType)
}
