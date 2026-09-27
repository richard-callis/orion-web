/**
 * Role-based tool policy for the interactive (human) chat path in claude.ts.
 *
 * This is the static, role-level layer that runs BEFORE the environment-level
 * checks (ToolAgentRestriction, ToolGroup minimum tier, one-time grants):
 *
 * - readonly / unauthenticated users get no tools at all.
 * - admins may call anything.
 * - regular users may not call admin-only tools, and destructive tools
 *   (registry tier 'destructive', or a gateway tool that mutates infrastructure)
 *   need either an environment-level admin tier or a one-time ToolExecutionGrant.
 *
 * Previously, a tool in no ToolGroup was treated as unrestricted, and registry
 * management tools are never in a ToolGroup — so any logged-in user (including
 * readonly) could call orion_patch_environment and repoint an environment's
 * gatewayUrl, leaking its gateway token.
 */

import { prisma } from './db'
import { getToolDefinition } from './tool-registry'

export type ChatUserRole = 'admin' | 'user' | 'readonly' | 'anonymous'

/** Registry tools that only a global admin may invoke from human chat. */
export const ADMIN_ONLY_CHAT_TOOLS: ReadonlySet<string> = new Set([
  'orion_patch_environment',     // writes kubeconfig / gatewayUrl
  'orion_bootstrap_environment', // deploys ArgoCD + gateway into a cluster
  'approve_execution',           // approves executor shell commands
  'deny_execution',
  'gitea_merge_pr',              // merges straight into the GitOps source of truth
])

/**
 * Gateway builtins that mutate infrastructure or run arbitrary commands.
 * Gateway tools carry no tier metadata (McpTool has no tier column), so the
 * destructive set is maintained here. Keep in sync with apps/gateway/src/builtin-tools.
 */
export const DESTRUCTIVE_GATEWAY_TOOLS: ReadonlySet<string> = new Set([
  'kubectl_delete',
  'kubectl_apply_manifest',
  'kubectl_apply_url',
  'kubectl_patch',
  'kubectl_exec',
  'kubectl_rollout_restart',
  'helm_uninstall',
  'helm_upgrade_install',
  'helm_repo_add',
  'docker_exec',
  'docker_run',
  'shell_exec',
  'talos_patch_machineconfig',
  'talos_reboot',
  'talos_upgrade',
  'velero_restore',
  'crowdsec_decision_create',
  'crowdsec_decision_delete',
  'firewall_block',
  'wazuh_active_response',
])

export function normalizeRole(role: string | null | undefined): ChatUserRole {
  if (role === 'admin' || role === 'user' || role === 'readonly') return role
  // Unknown role strings fail closed to readonly.
  return role ? 'readonly' : 'anonymous'
}

export async function getChatUserRole(userId: string | undefined): Promise<ChatUserRole> {
  if (!userId) return 'anonymous'
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } })
  if (!user || user.active === false) return 'anonymous'
  return normalizeRole(user.role)
}

export function canUseTools(role: ChatUserRole): boolean {
  return role === 'admin' || role === 'user'
}

/**
 * Whether a tool is destructive. `customShell` marks a non-builtin gateway tool
 * whose execType is 'shell' (an arbitrary command template).
 */
export function isDestructiveChatTool(name: string, opts: { customShell?: boolean } = {}): boolean {
  if (opts.customShell) return true
  const def = getToolDefinition(name)
  if (def) return def.tier === 'destructive'
  return DESTRUCTIVE_GATEWAY_TOOLS.has(name)
}

export type ChatToolDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  /** Destructive for a non-admin: allowed only with env admin tier or a one-time grant. */
  | { decision: 'needs_elevation'; reason: string }

/** Pure role-level decision — no DB access, so it can be unit-tested directly. */
export function evaluateChatToolPolicy(
  name: string,
  role: ChatUserRole,
  opts: { customShell?: boolean } = {},
): ChatToolDecision {
  if (!canUseTools(role)) {
    return { decision: 'deny', reason: `Your account (${role}) is not permitted to run tools from chat.` }
  }
  if (role === 'admin') return { decision: 'allow' }
  if (ADMIN_ONLY_CHAT_TOOLS.has(name)) {
    return { decision: 'deny', reason: `\`${name}\` is restricted to administrators.` }
  }
  if (isDestructiveChatTool(name, opts)) {
    return { decision: 'needs_elevation', reason: `\`${name}\` is a destructive tool and requires **admin** access in this environment.` }
  }
  return { decision: 'allow' }
}

/**
 * Filter a tool list before it is offered to the model. Tools the role can
 * never call are removed; destructive tools that could still be unlocked by an
 * environment tier or grant stay visible and are gated at call time.
 */
export function filterToolsForRole<T>(tools: T[], role: ChatUserRole, nameOf: (t: T) => string): T[] {
  if (!canUseTools(role)) return []
  if (role === 'admin') return tools
  return tools.filter(t => {
    const name = nameOf(t)
    if (ADMIN_ONLY_CHAT_TOOLS.has(name)) return false
    return getToolDefinition(name)?.tier !== 'destructive'
  })
}

// ── Full chat permission check (DB-backed) ─────────────────────────────────────

const TIER_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 }

/**
 * Full permission check for a tool call from human chat: role policy first,
 * then ToolAgentRestriction, ToolGroup minimum tier / env tier, and finally a
 * one-time ToolExecutionGrant or a new approval request.
 */
export async function checkChatToolPermission(
  toolName: string,
  toolArgs: Record<string, unknown>,
  environmentId: string,
  conversationId: string,
  userId: string | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  // Role-level gate first: readonly/anonymous users get no tools, admin-only
  // tools are denied outright, destructive tools need elevation (below).
  const role = await getChatUserRole(userId)
  if (!canUseTools(role) || !userId) {
    return { allowed: false, reason: `Your account is not permitted to run tools from chat.` }
  }

  // Check if tool is agent-restricted (only specific agents may run it)
  const restrictionCount = environmentId
    ? await prisma.toolAgentRestriction.count({ where: { tool: { name: toolName, environmentId } } })
    : 0
  if (restrictionCount > 0) {
    return { allowed: false, reason: `\`${toolName}\` is restricted to specific agents only and cannot be called from human chat.` }
  }

  // Custom (non-builtin) shell tools run arbitrary command templates — treat as destructive.
  const mcpTool = environmentId
    ? await prisma.mcpTool.findFirst({ where: { name: toolName, environmentId }, select: { builtIn: true, execType: true } })
    : null
  const customShell = !!mcpTool && !mcpTool.builtIn && mcpTool.execType === 'shell'

  const policy = evaluateChatToolPolicy(toolName, role, { customShell })
  if (policy.decision === 'deny') return { allowed: false, reason: policy.reason }
  if (role === 'admin') return { allowed: true }

  // Get user's tier in this environment (default: viewer)
  const tierRecord = environmentId
    ? await prisma.environmentUserTier.findUnique({ where: { userId_environmentId: { userId, environmentId } } })
    : null
  const userTierRank = TIER_RANK[tierRecord?.tier ?? 'viewer'] ?? 0

  // Find which tool groups this tool belongs to (in this environment)
  const toolGroupMemberships = environmentId
    ? await prisma.toolGroupTool.findMany({
        where: { tool: { name: toolName, environmentId } },
        include: { toolGroup: true },
      })
    : []

  // Required tier: the lowest group minimum the user could qualify through;
  // destructive tools with no group default to requiring env admin.
  let requiredRank: number
  if (toolGroupMemberships.length > 0) {
    requiredRank = Math.min(...toolGroupMemberships.map(m => TIER_RANK[m.toolGroup.minimumTier] ?? 0))
    if (policy.decision === 'needs_elevation') requiredRank = Math.max(requiredRank, TIER_RANK.operator)
  } else {
    requiredRank = policy.decision === 'needs_elevation' ? TIER_RANK.admin : 0
  }

  if (userTierRank >= requiredRank) return { allowed: true }

  const requiredTierName = Object.entries(TIER_RANK).find(([, v]) => v === requiredRank)?.[0] ?? 'admin'
  return consumeGrantOrRequestApproval(toolName, toolArgs, environmentId, conversationId, userId, requiredTierName)
}

/** Blocked by tier: consume a one-time ToolExecutionGrant, or file an approval request. */
async function consumeGrantOrRequestApproval(
  toolName: string,
  toolArgs: Record<string, unknown>,
  environmentId: string,
  conversationId: string,
  userId: string,
  requiredTierName: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!environmentId) {
    return { allowed: false, reason: `\`${toolName}\` requires **${requiredTierName}** access, and no environment is selected to request it in.` }
  }

  const grant = await prisma.toolExecutionGrant.findFirst({
    where: {
      userId,
      environmentId,
      toolName,
      usedAt:    null,
      expiresAt: { gt: new Date() },
    },
  })

  if (grant) {
    // Consume atomically so two concurrent calls can't both use one grant
    const consumed = await prisma.toolExecutionGrant.updateMany({
      where: { id: grant.id, usedAt: null },
      data:  { usedAt: new Date() },
    })
    if (consumed.count === 1) return { allowed: true }
  }

  // Don't create duplicate pending requests for the same tool in this conversation
  const existing = await prisma.toolApprovalRequest.findFirst({
    where: { conversationId, toolName, status: 'pending' },
  })
  if (!existing) {
    await prisma.toolApprovalRequest.create({
      data: {
        conversationId,
        userId,
        environmentId,
        toolName,
        toolArgs: toolArgs as never,
        reason: `User's tier is below the minimum required (${requiredTierName}) for this tool.`,
      },
    })
  }

  return {
    allowed: false,
    reason: `\`${toolName}\` requires **${requiredTierName}** access in this environment. An approval request has been submitted — an administrator can approve it, after which you can retry.`,
  }
}
