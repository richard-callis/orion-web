/**
 * Tool permission checks for agents (task runners, the MCP route, room agents).
 * Human chat has its own policy in chat-tool-policy.ts.
 *
 * - archived agents may not run any tool
 * - ToolAgentRestriction: if any restriction rows exist for this tool, only
 *   those agents may run it
 * - registry (ORION management) tools: read / write allowed; destructive needs
 *   a one-time ToolExecutionGrant
 * - gateway tools (kubectl_*, helm_*, custom tools): allowed — destructive ones
 *   included — only when ALL of:
 *     · the agent is active (not archived) and linked to the environment,
 *     · the tool is enabled in the environment's tool policy (McpTool row,
 *       enabled and status 'active'),
 *     · an admin has granted it: the tool is in a tool group the agent's agent
 *       group has access to (Admin → Agent Groups ↔ Environments → Tool Groups),
 *     · it is inside the agent's own allowlist (contextConfig.allowedTools), if set.
 *   The grant is the approval — no extra per-call grant for destructive tools.
 * - untrusted tasks (metadata.untrusted, e.g. webhook-created): every tool except
 *   registry read-tier tools additionally requires a one-time ToolExecutionGrant (SOC2 [M3])
 *
 * SOC2 [A-003]: Permission denials are returned to the LLM as a tool result
 * rather than a silent failure so the outcome is observable in the audit trail.
 */

import { prisma } from '@/lib/db'
import { getToolDefinition } from '@/lib/tool-registry'

// ── Helper: resolve environmentId from agentId ───────────────────────────────

async function resolveEnvironmentForAgent(agentId: string): Promise<string | null> {
  const envLink = await prisma.agentEnvironment.findFirst({
    where: { agentId },
    select: { environmentId: true },
  })
  return envLink?.environmentId ?? null
}

// ── Helper: agent state ───────────────────────────────────────────────────────

interface AgentState {
  exists: boolean
  archived: boolean
  /** contextConfig.allowedTools, when the agent has a narrowed tool list. */
  allowedTools: string[] | null
  name: string
}

async function loadAgentState(agentId: string): Promise<AgentState> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true, metadata: true } })
  if (!agent) return { exists: false, archived: false, allowedTools: null, name: agentId }
  const meta = (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}) as Record<string, unknown>
  const cc = (meta.contextConfig && typeof meta.contextConfig === 'object' ? meta.contextConfig : {}) as Record<string, unknown>
  return {
    exists: true,
    archived: meta.archived === true,
    allowedTools: Array.isArray(cc.allowedTools) ? cc.allowedTools.filter((t): t is string => typeof t === 'string') : null,
    name: agent.name,
  }
}

// ── Helper: gateway-tool grant (admin-configured) ─────────────────────────────

const GRANT_HINT = 'An admin can grant it under Admin → Agent Groups (give one of this agent\'s groups access to a tool group that contains it; tool groups are managed under Environments → Tool Groups).'

/** Returns a denial reason, or null when the agent may run this gateway tool. */
async function checkGatewayToolGrant(
  toolName: string,
  agent: AgentState,
  agentId: string,
  environmentId: string,
): Promise<string | null> {
  const tool = await prisma.mcpTool.findFirst({
    where: { environmentId, name: toolName },
    select: { id: true, enabled: true, status: true },
  })
  if (!tool || !tool.enabled || tool.status !== 'active') {
    return `\`${toolName}\` is not enabled in this environment's tool policy. An admin can enable it under Environments → Tools.`
  }
  const grant = await prisma.toolGroupTool.findFirst({
    where: {
      toolId: tool.id,
      toolGroup: { environmentId, agentAccess: { some: { agentGroup: { members: { some: { agentId } } } } } },
    },
    select: { toolGroupId: true },
  })
  if (!grant) return `\`${toolName}\` has not been granted to agent "${agent.name}". ${GRANT_HINT}`
  return null
}

// ── Helper: untrusted task context (SOC2 [M3]) ───────────────────────────────

function isUntrustedMetadata(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).untrusted === true
}

/**
 * True when the call originates from a task whose content came from outside
 * (webhook payloads, commit messages). With a taskId we check that task; the MCP
 * path (Claude runners) only knows the agent, so fall back to "this agent is
 * currently working an untrusted task" — conservative, since a prompt-injected run
 * reaches its tools through that agent's MCP token.
 */
async function isUntrustedTaskContext(agentId: string | null, taskId?: string | null): Promise<boolean> {
  if (taskId) {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { metadata: true } })
    return isUntrustedMetadata(task?.metadata)
  }
  if (agentId) {
    const task = await prisma.task.findFirst({
      where: {
        assignedAgent: agentId,
        status: 'in_progress',
        metadata: { path: ['untrusted'], equals: true },
      },
      select: { id: true },
    })
    return !!task
  }
  return false
}

// ── Helper: one-time grants ───────────────────────────────────────────────────

/**
 * Consume a one-time ToolExecutionGrant for (agent, env, tool) if one exists;
 * otherwise file a ToolApprovalRequest (once) so an admin can grant it.
 */
async function consumeGrantOrRequest(
  toolName: string,
  agentId: string,
  environmentId: string,
  requestReason: string,
): Promise<boolean> {
  const grant = await prisma.toolExecutionGrant.findFirst({
    where: {
      userId:        agentId,       // agentId stored in userId field for agent grants
      environmentId,
      toolName,
      usedAt:    null,
      expiresAt: { gt: new Date() },
    },
  })

  if (grant) {
    // Consume the one-time grant
    await prisma.toolExecutionGrant.update({
      where: { id: grant.id },
      data:  { usedAt: new Date() },
    })
    return true
  }

  // No grant — create an approval request if one doesn't already exist
  const existing = await prisma.toolApprovalRequest.findFirst({
    where: {
      userId:        agentId,
      environmentId,
      toolName,
      status:        'pending',
    },
  })

  if (!existing) {
    await prisma.toolApprovalRequest.create({
      data: {
        conversationId: `task-agent:${agentId}`,
        userId:        agentId,
        environmentId,
        toolName,
        reason: requestReason,
      },
    }).catch(() => {})
  }

  return false
}

// ── Main permission check ─────────────────────────────────────────────────────

/**
 * Check whether a task agent is permitted to call the named tool.
 *
 * @param toolName      - Name of the tool being called
 * @param agentId       - Agent ID from TaskRunContext (required for restriction checks)
 * @param environmentId - Environment ID (resolved from agentId if null)
 * @param userTier      - Optional user tier (used on the chat path only — ignored here)
 * @param opts.taskId   - Task being run, when known (runner paths). Used for the
 *                        untrusted-task gate; without it the agent's in-progress tasks are checked.
 *
 * @returns { allowed: true } or { allowed: false, reason: string }
 */
export async function checkToolPermission(
  toolName: string,
  agentId: string | null,
  environmentId: string | null,
  _userTier?: string,  // unused on task path — kept for API symmetry
  opts?: { taskId?: string | null },
): Promise<{ allowed: boolean; reason?: string }> {
  // Resolve environmentId from agent link if not provided
  let resolvedEnvId = environmentId
  if (!resolvedEnvId && agentId) {
    resolvedEnvId = await resolveEnvironmentForAgent(agentId)
  }

  const def = getToolDefinition(toolName)
  const agentState = agentId ? await loadAgentState(agentId) : null

  // Archived agents may not act at all.
  if (agentState?.archived) {
    return { allowed: false, reason: `Agent "${agentState.name}" is archived and may not run tools.` }
  }

  // ── ToolAgentRestriction check ────────────────────────────────────────────
  // Gateway tools (McpTool rows) may be restricted to specific agents.
  // If restriction rows exist and this agent is NOT in them, deny.
  //
  // FAIL-CLOSED: if resolvedEnvId is null (agent has no environment link), we cannot
  // scope the check to one environment — but we must not silently skip it. Instead we
  // check whether ANY restriction rows exist for this tool across all environments. If
  // they do, deny (restricted tool + no env context = denied). Only if no restrictions
  // exist anywhere do we fall through to the tier check.
  if (resolvedEnvId) {
    const allRestrictions = await prisma.toolAgentRestriction.findMany({
      where: {
        tool: { name: toolName, environmentId: resolvedEnvId },
      },
      select: { agentId: true },
    })

    if (allRestrictions.length > 0) {
      const agentAllowed = agentId && allRestrictions.some(r => r.agentId === agentId)
      if (!agentAllowed) {
        return {
          allowed: false,
          reason: `\`${toolName}\` is restricted to specific agents only. This agent (${agentId ?? 'unknown'}) is not in the allowed list.`,
        }
      }
    }
  } else {
    // No environment context — check for any restriction rows across all environments.
    const anyRestriction = await prisma.toolAgentRestriction.findFirst({
      where: { tool: { name: toolName } },
      select: { agentId: true },
    })
    if (anyRestriction) {
      return {
        allowed: false,
        reason: `\`${toolName}\` is restricted to specific agents in one or more environments. This agent (${agentId ?? 'unknown'}) has no environment link — cannot verify authorization. Assign this agent to an environment to use restricted tools.`,
      }
    }
  }

  // ── AgentGroupToolAccess check ────────────────────────────────────────────
  // If this tool belongs to any ToolGroup(s) in this environment, an agent may
  // only call it if it is a member of an AgentGroup granted access to one of
  // those ToolGroups. Tools in no ToolGroup remain unrestricted.
  // Previously this mechanism was stored in the DB but never enforced — the
  // admin UI showed group→tool-group access grants that had zero runtime effect.
  //
  // FAIL-CLOSED: same as above — if no env context, check across all environments.
  if (resolvedEnvId) {
    const groupMemberships = await prisma.toolGroupTool.findMany({
      where: { tool: { name: toolName, environmentId: resolvedEnvId } },
      select: { toolGroupId: true },
    })

    if (groupMemberships.length > 0) {
      if (!agentId) {
        return {
          allowed: false,
          reason: `\`${toolName}\` belongs to a restricted tool group and requires agent-group authorization, but no agent context is available.`,
        }
      }

      const toolGroupIds = groupMemberships.map(m => m.toolGroupId)
      const grantedAccess = await prisma.agentGroupToolAccess.findFirst({
        where: {
          toolGroupId: { in: toolGroupIds },
          agentGroup:  { members: { some: { agentId } } },
        },
        select: { agentGroupId: true },
      })

      if (!grantedAccess) {
        return {
          allowed: false,
          reason: `\`${toolName}\` belongs to a tool group this agent has not been granted access to. Add the agent to an agent group with access to the tool group.`,
        }
      }
    }
  } else {
    // No environment context — check for any tool-group memberships across all environments.
    const anyGroupMembership = await prisma.toolGroupTool.findFirst({
      where: { tool: { name: toolName } },
      select: { toolGroupId: true },
    })
    if (anyGroupMembership) {
      return {
        allowed: false,
        reason: `\`${toolName}\` belongs to a restricted tool group in one or more environments. This agent (${agentId ?? 'unknown'}) has no environment link — cannot verify group authorization. Assign this agent to an environment to use tool-group-restricted tools.`,
      }
    }
  }

  // ── Gateway tools: admin grant required (checked before the untrusted gate) ──
  if (!def) {
    if (!agentId || !agentState?.exists) {
      return { allowed: false, reason: `\`${toolName}\` is a gateway tool and can only be run by a registered, active agent.` }
    }
    if (agentState.allowedTools && !agentState.allowedTools.includes(toolName)) {
      return { allowed: false, reason: `\`${toolName}\` is outside agent "${agentState.name}"'s allowed tool list.` }
    }
    if (!resolvedEnvId) {
      return { allowed: false, reason: `\`${toolName}\` is a gateway tool, but agent "${agentState.name}" is not linked to an environment.` }
    }
    const denial = await checkGatewayToolGrant(toolName, agentState, agentId, resolvedEnvId)
    if (denial) return { allowed: false, reason: denial }
  }

  // ── Untrusted task gate (SOC2 [M3]) ─────────────────────────────────────
  // Webhook-created tasks carry attacker-influenced text. Only registry read-tier
  // tools run freely; every write/destructive registry tool and every gateway tool
  // (even a granted one) additionally needs a one-time admin approval.
  if ((!def || def.tier !== 'read') && await isUntrustedTaskContext(agentId, opts?.taskId)) {
    if (!agentId || !resolvedEnvId) {
      return {
        allowed: false,
        reason: `\`${toolName}\` cannot run from an untrusted (externally triggered) task without an agent and environment context to check for an admin grant.`,
      }
    }
    const granted = await consumeGrantOrRequest(
      toolName, agentId, resolvedEnvId,
      `Agent "${agentId}" is working an untrusted (webhook-triggered) task and requested \`${toolName}\`.`,
    )
    if (granted) return { allowed: true }
    return {
      allowed: false,
      reason: `\`${toolName}\` requires admin approval because this task was created from an external trigger (untrusted input). An approval request has been filed — use read-only tools until an admin grants access.`,
    }
  }

  // ── Tier check from unified tool registry ────────────────────────────────
  if (!def) {
    // Gateway tool granted to this agent (checked above) — the grant is the approval
    return { allowed: true }
  }

  if (def.tier === 'read' || def.tier === 'write') {
    return { allowed: true }
  }

  // Destructive tier — require an explicit ToolExecutionGrant for this agent
  if (def.tier === 'destructive') {
    if (!agentId || !resolvedEnvId) {
      return {
        allowed: false,
        reason: `\`${toolName}\` is a destructive tool and requires explicit authorization. No agent or environment context available to check for a grant.`,
      }
    }

    const granted = await consumeGrantOrRequest(
      toolName, agentId, resolvedEnvId,
      `Task agent "${agentId}" requires destructive tool access. Call orion_request_tool_grant to request explicit authorization.`,
    )
    if (granted) return { allowed: true }

    return {
      allowed: false,
      reason:  `\`${toolName}\` is a destructive tool and requires explicit authorization. Use \`orion_request_tool_grant\` to request access — an admin must approve before this tool can be called.`,
    }
  }

  return { allowed: true }
}
