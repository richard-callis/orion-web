/**
 * Tool permission checks for the task runner path.
 *
 * The interactive chat path has its own full permission logic in claude.ts that
 * checks user tiers, ToolGroup membership, and ToolAgentRestrictions. This module
 * provides a simpler version for task agents:
 *
 * - read / write tier tools: allowed by default
 * - destructive tier tools: require an explicit ToolExecutionGrant (keyed by agentId)
 * - ToolAgentRestriction: if any restriction rows exist for this tool+agent, block
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

// ── Main permission check ─────────────────────────────────────────────────────

/**
 * Check whether a task agent is permitted to call the named tool.
 *
 * @param toolName      - Name of the tool being called
 * @param agentId       - Agent ID from TaskRunContext (required for restriction checks)
 * @param environmentId - Environment ID (resolved from agentId if null)
 * @param userTier      - Optional user tier (used on the chat path only — ignored here)
 *
 * @returns { allowed: true } or { allowed: false, reason: string }
 */
export async function checkToolPermission(
  toolName: string,
  agentId: string | null,
  environmentId: string | null,
  _userTier?: string,  // unused on task path — kept for API symmetry
): Promise<{ allowed: boolean; reason?: string }> {
  // Resolve environmentId from agent link if not provided
  let resolvedEnvId = environmentId
  if (!resolvedEnvId && agentId) {
    resolvedEnvId = await resolveEnvironmentForAgent(agentId)
  }

  // ── ToolAgentRestriction check ────────────────────────────────────────────
  // Gateway tools (McpTool rows) may be restricted to specific agents.
  // If restriction rows exist and this agent is NOT in them, deny.
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
  }

  // ── AgentGroupToolAccess check ────────────────────────────────────────────
  // If this tool belongs to any ToolGroup(s) in this environment, an agent may
  // only call it if it is a member of an AgentGroup granted access to one of
  // those ToolGroups. Tools in no ToolGroup remain unrestricted.
  // Previously this mechanism was stored in the DB but never enforced — the
  // admin UI showed group→tool-group access grants that had zero runtime effect.
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
  }

  // ── Tier check from unified tool registry ────────────────────────────────
  const def = getToolDefinition(toolName)
  if (!def) {
    // Tool not in management registry — it's a gateway tool; allowed if restriction check passed
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

    const grant = await prisma.toolExecutionGrant.findFirst({
      where: {
        userId:        agentId,       // agentId stored in userId field for agent grants
        environmentId: resolvedEnvId,
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
      return { allowed: true }
    }

    // No grant — create an approval request if one doesn't already exist
    const existing = await prisma.toolApprovalRequest.findFirst({
      where: {
        userId:        agentId,
        environmentId: resolvedEnvId,
        toolName,
        status:        'pending',
      },
    })

    if (!existing) {
      await prisma.toolApprovalRequest.create({
        data: {
          conversationId: `task-agent:${agentId}`,
          userId:        agentId,
          environmentId: resolvedEnvId,
          toolName,
          reason: `Task agent "${agentId}" requires destructive tool access. Call orion_request_tool_grant to request explicit authorization.`,
        },
      }).catch(() => {})
    }

    return {
      allowed: false,
      reason:  `\`${toolName}\` is a destructive tool and requires explicit authorization. Use \`orion_request_tool_grant\` to request access — an admin must approve before this tool can be called.`,
    }
  }

  return { allowed: true }
}
