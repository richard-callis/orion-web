/**
 * Access management tools: tool grants, tool groups and agent groups.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { auditLog, parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const RequestToolGrantArgs = z.object({
  tool_name: z.string().nullish(),
  reason: z.string().nullish(),
})

async function handleRequestToolGrant(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { tool_name, reason } = parseToolArgs(RequestToolGrantArgs, args)

  if (!tool_name?.trim()) return 'Error: tool_name is required'
  if (!reason?.trim())    return 'Error: reason is required — explain why this destructive tool is needed'

  const actorId = ctx.agentId ?? ctx.userId
  if (!actorId) return 'Error: actorId is required to request a tool grant (SOC2 attribution)'

  // Resolve environmentId from agent link
  let resolvedEnvId = ctx.environmentId ?? null
  if (!resolvedEnvId && ctx.agentId) {
    const envLink = await ctx.prisma.agentEnvironment.findFirst({
      where:  { agentId: ctx.agentId },
      select: { environmentId: true },
    })
    resolvedEnvId = envLink?.environmentId ?? null
  }

  if (!resolvedEnvId) return 'Error: no environment linked to this agent — cannot create a tool grant request'

  // De-duplicate: only create one pending request per (agent, tool)
  const existing = await ctx.prisma.toolApprovalRequest.findFirst({
    where: {
      userId:        actorId,
      environmentId: resolvedEnvId,
      toolName:      tool_name.trim(),
      status:        'pending',
    },
  })

  if (existing) {
    return `A pending grant request for \`${tool_name.trim()}\` already exists (id: ${existing.id}). An admin must approve it before you can use this tool.`
  }

  const request = await ctx.prisma.toolApprovalRequest.create({
    data: {
      conversationId: `task-agent:${actorId}`,
      userId:         actorId,
      environmentId:  resolvedEnvId,
      toolName:       tool_name.trim(),
      reason:         reason.trim(),
    },
  })

  const msg = `🔒 Tool grant requested: **${tool_name.trim()}** — ${reason.trim().slice(0, 200)}`
  await auditLog(actorId, msg)

  return `Grant request submitted (id: ${request.id}) for \`${tool_name.trim()}\`. An admin must approve this request in the ORION UI (Administration → Approvals) before you can call this tool. Reason recorded: ${reason.trim()}`
}

export const orionRequestToolGrantTool: ToolDefinition = {
  name: 'orion_request_tool_grant',
  description: 'Request explicit authorization to call a destructive-tier tool. Creates an approval request that a human admin must review in the ORION UI (Administration → Approvals). Once approved, a one-time grant is created and the next call to the tool will succeed. Use this when a tool call was denied with "destructive tool requires explicit authorization".',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Exact name of the destructive tool being requested (e.g. "orion_archive_agent")' },
      reason:    { type: 'string', description: 'Why this destructive tool is needed for the current task — be specific' },
    },
    required: ['tool_name', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'tools',
  handler: handleRequestToolGrant,
}

// ── Coordinator gate for tool/agent-group access management ───────────────────
// Only agents in the "Access Admins" agent group may grant/revoke tool-group
// access or agent-group membership. Without this, tier: 'write' alone is not
// enforced by checkToolPermission() (see tool-permissions.ts) — any agent with
// tools enabled could otherwise add itself to a group with Ops access and
// bypass the AgentGroupToolAccess gate entirely.
export const ACCESS_ADMIN_GROUP_NAME = 'Access Admins'

async function requireAccessAdmin(ctx: ToolExecutionContext): Promise<string | null> {
  if (!ctx.agentId) {
    return 'Error: no agent identity on this call — access management requires an authenticated agent.'
  }
  const membership = await ctx.prisma.agentGroupMember.findFirst({
    where: { agentId: ctx.agentId, agentGroup: { name: ACCESS_ADMIN_GROUP_NAME } },
  })
  if (!membership) {
    return `Error: this action requires membership in the "${ACCESS_ADMIN_GROUP_NAME}" agent group. This agent is not authorized to manage tool or agent group access.`
  }
  return null
}

// ── list_tool_groups ──────────────────────────────────────────────────────────
// Read-only visibility into every ToolGroup and which AgentGroups may use it.
// Coordinator agents (Alpha) use this to see the full tool landscape without
// ever being able to execute any of the tools themselves.

export const listToolGroupsTool: ToolDefinition = {
  name: 'list_tool_groups',
  description: 'List every tool group, the tools it bundles, and which agent groups currently have access to it. Use this to see the full tool landscape before deciding who should be granted access to what. This tool only reports state — it never executes any of the listed tools.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Filter to one environment (optional)' },
    },
    required: [],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { environment_id } = args as { environment_id?: string }
    const groups = await ctx.prisma.toolGroup.findMany({
      where: environment_id ? { environmentId: environment_id } : undefined,
      include: {
        tools:       { include: { tool: { select: { name: true } } } },
        agentAccess: { include: { agentGroup: { select: { id: true, name: true } } } },
        environment: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    })
    if (groups.length === 0) return 'No tool groups defined.'
    return groups.map(g => {
      const toolNames  = g.tools.map(t => t.tool.name).join(', ') || 'none'
      const grantedTo  = g.agentAccess.map(a => `${a.agentGroup.name} (${a.agentGroup.id})`).join(', ') || 'no agent groups granted'
      return `[${g.id}] ${g.name} (env: ${g.environment.name}) — tools: ${toolNames} — granted to: ${grantedTo}`
    }).join('\n')
  },
}

// ── list_agent_groups ─────────────────────────────────────────────────────────

export const listAgentGroupsTool: ToolDefinition = {
  name: 'list_agent_groups',
  description: 'List every agent group, its member agents, and which tool groups it has been granted access to. Use this before granting or revoking tool access, or before deciding which group a specialist agent should join.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (_args, ctx) => {
    const groups = await ctx.prisma.agentGroup.findMany({
      include: {
        members:    { include: { agent: { select: { name: true, status: true } } } },
        toolAccess: { include: { toolGroup: { select: { id: true, name: true } } } },
      },
      orderBy: { name: 'asc' },
    })
    if (groups.length === 0) return 'No agent groups defined.'
    return groups.map(g => {
      const memberNames = g.members.map(m => `${m.agent.name} (${m.agent.status})`).join(', ') || 'no members'
      const toolGroups  = g.toolAccess.map(a => `${a.toolGroup.name} (${a.toolGroup.id})`).join(', ') || 'no tool group access'
      return `[${g.id}] ${g.name} — members: ${memberNames} — tool access: ${toolGroups}`
    }).join('\n')
  },
}

// ── manage_tool_group_access ──────────────────────────────────────────────────
// Grants or revokes an AGENT GROUP's access to a TOOL GROUP. This is the only
// way a coordinator agent may affect which tools another agent can call — it
// never calls the tools directly itself.

export const manageToolGroupAccessTool: ToolDefinition = {
  name: 'manage_tool_group_access',
  description: `Grant or revoke an agent group's access to a tool group. This changes WHO CAN use a set of tools — it does not execute any tool. Use list_tool_groups and list_agent_groups first to find the right IDs or names. Requires membership in the "${ACCESS_ADMIN_GROUP_NAME}" agent group.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:      { type: 'string', enum: ['grant', 'revoke'], description: 'Whether to grant or revoke access' },
      agentGroup:  { type: 'string', description: 'Agent group id or exact name (globally unique)' },
      toolGroup:   { type: 'string', description: 'Tool group id or exact name. Tool group names are only unique per environment — if the name matches groups in more than one environment, also pass "environment".' },
      environment: { type: 'string', description: 'Environment id or name, used only to disambiguate toolGroup when referring to it by name (optional)' },
    },
    required: ['action', 'agentGroup', 'toolGroup'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const denied = await requireAccessAdmin(ctx)
    if (denied) return denied

    const { action, agentGroup: agentGroupRef, toolGroup: toolGroupRef, environment: environmentRef } =
      args as { action?: string; agentGroup?: string; toolGroup?: string; environment?: string }

    if (action !== 'grant' && action !== 'revoke') return 'Error: action must be "grant" or "revoke"'
    if (!agentGroupRef) return 'Error: agentGroup is required (id or name)'
    if (!toolGroupRef)  return 'Error: toolGroup is required (id or name)'

    const agentGroup = await ctx.prisma.agentGroup.findFirst({ where: { OR: [{ id: agentGroupRef }, { name: agentGroupRef }] } })
    if (!agentGroup) return `Error: agent group "${agentGroupRef}" not found. Call list_agent_groups to see valid options.`

    // ToolGroup.name is unique per environment, not globally — resolve by id first,
    // then by name scoped to an environment if given, and refuse to guess if the
    // name is still ambiguous across environments.
    let toolGroup = await ctx.prisma.toolGroup.findUnique({ where: { id: toolGroupRef } })
    if (!toolGroup) {
      const where: Record<string, unknown> = { name: toolGroupRef }
      if (environmentRef) {
        const env = await ctx.prisma.environment.findFirst({ where: { OR: [{ id: environmentRef }, { name: environmentRef }] } })
        if (!env) return `Error: environment "${environmentRef}" not found.`
        where.environmentId = env.id
      }
      const matches = await ctx.prisma.toolGroup.findMany({ where, include: { environment: { select: { name: true } } } })
      if (matches.length === 0) return `Error: tool group "${toolGroupRef}" not found. Call list_tool_groups to see valid options.`
      if (matches.length > 1) {
        const envNames = matches.map(m => m.environment.name).join(', ')
        return `Error: multiple tool groups named "${toolGroupRef}" exist (environments: ${envNames}) — pass "environment" to disambiguate, or use the tool group id from list_tool_groups.`
      }
      toolGroup = matches[0]
    }

    if (action === 'grant') {
      const existing = await ctx.prisma.agentGroupToolAccess.findUnique({
        where: { agentGroupId_toolGroupId: { agentGroupId: agentGroup.id, toolGroupId: toolGroup.id } },
      })
      if (existing) return `Agent group "${agentGroup.name}" already has access to tool group "${toolGroup.name}".`
      await ctx.prisma.agentGroupToolAccess.create({ data: { agentGroupId: agentGroup.id, toolGroupId: toolGroup.id } })
      await auditLog(ctx.agentId, `🔑 Granted agent group **${agentGroup.name}** access to tool group **${toolGroup.name}**`)
      return `Granted "${agentGroup.name}" access to tool group "${toolGroup.name}".`
    }

    await ctx.prisma.agentGroupToolAccess.delete({
      where: { agentGroupId_toolGroupId: { agentGroupId: agentGroup.id, toolGroupId: toolGroup.id } },
    }).catch(() => null)
    await auditLog(ctx.agentId, `🔒 Revoked agent group **${agentGroup.name}**'s access to tool group **${toolGroup.name}**`)
    return `Revoked "${agentGroup.name}"'s access to tool group "${toolGroup.name}" (if it existed).`
  },
}

// ── manage_agent_group_membership ─────────────────────────────────────────────

export const manageAgentGroupMembershipTool: ToolDefinition = {
  name: 'manage_agent_group_membership',
  description: `Add or remove an agent from an agent group. Use this to put a specialist agent into a group so it inherits that group's tool-group access, before or after granting the group access with manage_tool_group_access. Requires membership in the "${ACCESS_ADMIN_GROUP_NAME}" agent group.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:     { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove the agent' },
      agentGroup: { type: 'string', description: 'Agent group id or exact name' },
      agent:      { type: 'string', description: 'Agent id or exact name' },
    },
    required: ['action', 'agentGroup', 'agent'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const denied = await requireAccessAdmin(ctx)
    if (denied) return denied

    const { action, agentGroup: agentGroupRef, agent: agentRef } =
      args as { action?: string; agentGroup?: string; agent?: string }

    if (action !== 'add' && action !== 'remove') return 'Error: action must be "add" or "remove"'
    if (!agentGroupRef) return 'Error: agentGroup is required (id or name)'
    if (!agentRef)      return 'Error: agent is required (id or name)'

    const agentGroup = await ctx.prisma.agentGroup.findFirst({ where: { OR: [{ id: agentGroupRef }, { name: agentGroupRef }] } })
    if (!agentGroup) return `Error: agent group "${agentGroupRef}" not found. Call list_agent_groups to see valid options.`

    const agent = await ctx.prisma.agent.findFirst({ where: { OR: [{ id: agentRef }, { name: agentRef }] } })
    if (!agent) return `Error: agent "${agentRef}" not found.`

    if (action === 'add') {
      const existing = await ctx.prisma.agentGroupMember.findUnique({
        where: { agentGroupId_agentId: { agentGroupId: agentGroup.id, agentId: agent.id } },
      })
      if (existing) return `"${agent.name}" is already a member of "${agentGroup.name}".`
      await ctx.prisma.agentGroupMember.create({ data: { agentGroupId: agentGroup.id, agentId: agent.id } })
      await auditLog(ctx.agentId, `👥 Added **${agent.name}** to agent group **${agentGroup.name}**`)
      return `Added "${agent.name}" to agent group "${agentGroup.name}".`
    }

    await ctx.prisma.agentGroupMember.delete({
      where: { agentGroupId_agentId: { agentGroupId: agentGroup.id, agentId: agent.id } },
    }).catch(() => null)
    await auditLog(ctx.agentId, `👥 Removed **${agent.name}** from agent group **${agentGroup.name}**`)
    return `Removed "${agent.name}" from agent group "${agentGroup.name}" (if it was a member).`
  },
}
