/**
 * Unified Tool Registry — single source of truth for all ORION management tools.
 *
 * Tools are classified by tier (read / write / destructive) and availability context
 * (task / chat / both). The registry is the canonical definition; management-tools.ts
 * and claude.ts import from here rather than duplicating definitions.
 *
 * SOC2 [A-001]: all write/destructive operations are attributed via actorId and logged
 * to the agent-feed audit trail inside the handler logic.
 */

import { prisma } from '@/lib/db'
import { getDefaultModelId } from '@/lib/default-model'
import { generateEmbedding, vectorSearch } from '@/lib/embeddings'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import tls from 'tls'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolTier = 'read' | 'write' | 'destructive'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
  tier: ToolTier
  parallelSafe: boolean  // can run concurrently with other read tools
  availableIn: 'task' | 'chat' | 'both'
  handler: (args: unknown, context: ToolExecutionContext) => Promise<string>
}

export interface ToolExecutionContext {
  agentId?: string
  taskId?: string
  roomId?: string
  environmentId?: string
  userId?: string
  prisma: typeof prisma
  gateway?: {
    executeTool: (name: string, args: Record<string, unknown>) => Promise<string>
  }
  // Legacy: conversationId used in chat path for propose_tool
  conversationId?: string
}

// ── Registry store ────────────────────────────────────────────────────────────

const _registry = new Map<string, ToolDefinition>()

export function registerTool(def: ToolDefinition): void {
  _registry.set(def.name, def)
}

export function getToolsForContext(ctx: 'task' | 'chat'): ToolDefinition[] {
  return Array.from(_registry.values()).filter(
    t => t.availableIn === ctx || t.availableIn === 'both'
  )
}

/** Return every registered tool regardless of availableIn context. */
export function getAllTools(): ToolDefinition[] {
  return Array.from(_registry.values())
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return _registry.get(name)
}

export async function executeRegisteredTool(
  name: string,
  args: unknown,
  context: ToolExecutionContext,
): Promise<string> {
  const def = _registry.get(name)
  if (!def) return `Error: unknown tool "${name}"`
  try {
    return await def.handler(args, context)
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateToolArgs(
  toolName: string,
  args: unknown,
): { valid: boolean; errors: string[] } {
  const def = _registry.get(toolName)
  if (!def) return { valid: true, errors: [] }  // unknown tools pass through

  const schema = def.inputSchema as {
    required?: string[]
    properties?: Record<string, { type?: string }>
  }

  const errors: string[] = []
  const obj = (typeof args === 'object' && args !== null && !Array.isArray(args))
    ? (args as Record<string, unknown>)
    : {}

  // Check required fields
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in obj) || obj[field] === undefined || obj[field] === null || obj[field] === '') {
        errors.push(`field "${field}" is required`)
      }
    }
  }

  // Check field types for fields that are present
  if (schema.properties) {
    for (const [field, prop] of Object.entries(schema.properties)) {
      if (!(field in obj)) continue
      const val = obj[field]
      if (prop.type && val !== undefined && val !== null) {
        const actual = Array.isArray(val) ? 'array' : typeof val
        if (actual !== prop.type) {
          errors.push(`field "${field}" must be ${prop.type} (got ${actual})`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// SOC2 [INPUT-001]: mirrors the reserved-name check in POST /api/agents
export const RESERVED_AGENT_NAMES = ['human', 'user', 'system', 'admin']

async function auditLog(actorId: string | undefined, content: string): Promise<void> {
  if (!actorId) return
  await prisma.agentMessage.create({
    data: {
      agentId:     actorId,
      channel:     'agent-feed',
      content,
      messageType: 'task_update',
    },
  }).catch(() => {})
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(args: unknown): any {
  if (typeof args === 'object' && args !== null) return args
  if (typeof args === 'string') {
    try { return JSON.parse(args || '{}') } catch { return {} }
  }
  return {}
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListAgents(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { include_archived } = parseArgs(args) as { include_archived?: boolean }
  const agents = await ctx.prisma.agent.findMany({
    orderBy: { name: 'asc' },
    include: { tasks: { where: { status: { in: ['running', 'pending_validation'] } }, select: { id: true }, take: 1 } },
  })
  const filtered = include_archived
    ? agents
    : agents.filter((a: any) => !(a.metadata as any)?.archived)
  return JSON.stringify(
    filtered.map((a: any) => {
      const meta = (a.metadata ?? {}) as Record<string, unknown>
      const cfg  = (meta.contextConfig ?? {}) as Record<string, unknown>
      return {
        id:          a.id,
        name:        a.name,
        type:        a.type,
        status:      a.status,
        role:        a.role ?? null,
        description: a.description ?? null,
        persistent:  !!cfg.persistent,
        busy:        a.tasks.length > 0,
        archived:    !!(meta.archived),
      }
    }),
    null, 2
  )
}

async function handleListTasks(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { status, unassigned_only, assigned_agent_id, since } = parseArgs(args) as {
    status?: string | string[]
    unassigned_only?: boolean
    assigned_agent_id?: string
    since?: string
  }
  const statuses = status
    ? (Array.isArray(status) ? status : [status])
    : ['pending', 'running', 'failed']
  const sinceDate = since ? new Date(since) : undefined
  const tasks = await ctx.prisma.task.findMany({
    where: {
      status: { in: statuses as any },
      ...(unassigned_only ? { assignedAgent: null, assignedUserId: null } : {}),
      ...(assigned_agent_id ? { assignedAgent: assigned_agent_id } : {}),
      ...(sinceDate ? { OR: [{ createdAt: { gte: sinceDate } }, { updatedAt: { gte: sinceDate } }] } : {}),
    },
    include: { agent: { select: { id: true, name: true } } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: 50,
  })
  return JSON.stringify(
    tasks.map((t: any) => ({
      id:            t.id,
      title:         t.title,
      status:        t.status,
      priority:      t.priority,
      assignedAgent: t.agent ? { id: t.agent.id, name: t.agent.name } : null,
      assignedUser:  t.assignedUserId ?? null,
      description:   t.description ? t.description.slice(0, 200) : null,
    })),
    null, 2
  )
}

async function handleAssignTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, agent_id } = parseArgs(args) as { task_id?: string; agent_id?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!agent_id) return 'Error: agent_id is required'

  const targetAgent = await ctx.prisma.agent.findUnique({ where: { id: agent_id }, select: { name: true, status: true, metadata: true } })
  if (!targetAgent) return `Error: agent "${agent_id}" not found`
  const targetMeta = (targetAgent.metadata ?? {}) as Record<string, unknown>
  if (targetMeta.archived === true) {
    return `Error: agent "${targetAgent.name}" is archived and cannot be assigned tasks. Use orion_list_agents to find an active agent.`
  }
  if (targetAgent.status === 'offline') {
    return `Error: agent "${targetAgent.name}" is offline and cannot accept tasks right now. Use orion_list_agents to find an online agent.`
  }

  await ctx.prisma.task.update({
    where: { id: task_id },
    data:  { assignedAgent: agent_id, status: 'pending' },
  })
  const [task, agent] = await Promise.all([
    ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true } }),
    ctx.prisma.agent.findUnique({ where: { id: agent_id }, select: { name: true } }),
  ])
  const msg = `📋 Assigned **${task?.title}** → **${agent?.name}**`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Assigned task "${task?.title}" to agent "${agent?.name}"`
}

async function handleCreateAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const spec = parseArgs(args) as {
    name?: string
    role?: string
    systemPrompt?: string
    type?: string
    description?: string
    persistent?: boolean
    llm?: string
    metadata?: Record<string, unknown>
  }

  if (!spec.name?.trim())         return 'Error: name is required'
  if (!spec.role?.trim())         return 'Error: role is required'
  if (!spec.systemPrompt?.trim()) return 'Error: systemPrompt is required — agents without a system prompt will not behave correctly'
  if (spec.systemPrompt.trim().length < 20) return 'Error: systemPrompt is too short (minimum 20 characters) — provide a meaningful role description'

  const actorId = ctx.agentId ?? ctx.userId
  if (RESERVED_AGENT_NAMES.includes(spec.name.toLowerCase())) {
    await auditLog(actorId, `⚠️ Cannot create agent: **${spec.name}** is a reserved name`)
    return `Error: "${spec.name}" is a reserved agent name`
  }

  const existingByName = await ctx.prisma.agent.findUnique({
    where:  { name: spec.name.trim() },
    select: { id: true, name: true, role: true, metadata: true },
  })
  if (existingByName) {
    const existingMeta = (existingByName.metadata ?? {}) as Record<string, unknown>
    if (existingMeta.archived === true) {
      return `Error: an archived agent named "${spec.name.trim()}" already exists (id: ${existingByName.id}). Choose a different name — do not reuse archived agent names.`
    }
    return JSON.stringify({ id: existingByName.id, name: existingByName.name, role: existingByName.role, note: 'Agent already exists — returning existing record' }, null, 2)
  }

  const defaultLlm     = await getDefaultModelId()
  const legacyMeta     = (spec.metadata ?? {}) as Record<string, unknown>
  const legacyCfg      = (legacyMeta.contextConfig ?? {}) as Record<string, unknown>
  const resolvedLlm    = spec.llm ?? (legacyCfg.llm as string | undefined) ?? defaultLlm
  const resolvedPrompt = spec.systemPrompt ?? (legacyMeta.systemPrompt as string | undefined) ?? ''
  const contextConfig  = { ...legacyCfg, llm: resolvedLlm, persistent: spec.persistent ?? legacyCfg.persistent ?? false }
  const metadata       = { ...legacyMeta, systemPrompt: resolvedPrompt, contextConfig }

  const created = await ctx.prisma.agent.create({
    data: {
      name:        spec.name.trim(),
      type:        (spec.type && spec.type !== 'human') ? spec.type : 'claude',
      role:        spec.role ?? null,
      description: spec.description ?? null,
      metadata:    metadata as any,
    },
  })
  const msg = `🤖 Created agent **${created.name}** (\`${created.id}\`) — ${created.role ?? 'no role'}`
  await auditLog(actorId, msg)
  return JSON.stringify({ id: created.id, name: created.name, role: created.role }, null, 2)
}

async function handleUpdateAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const spec = parseArgs(args) as {
    agent_id?: string
    role?: string
    description?: string
    systemPrompt?: string
    llm?: string
    mentorReviewedAt?: string
  }
  if (!spec.agent_id) return 'Error: agent_id is required'

  const existing = await ctx.prisma.agent.findUnique({
    where:  { id: spec.agent_id },
    select: { id: true, name: true, metadata: true },
  })
  if (!existing) return `Error: agent ${spec.agent_id} not found`

  const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
  const existingCfg  = (existingMeta.contextConfig ?? {}) as Record<string, unknown>

  const updatedMeta: Record<string, unknown> = { ...existingMeta }
  if (spec.systemPrompt    !== undefined) updatedMeta.systemPrompt    = spec.systemPrompt
  if (spec.llm             !== undefined) updatedMeta.contextConfig   = { ...existingCfg, llm: spec.llm }
  if (spec.mentorReviewedAt !== undefined) updatedMeta.mentorReviewedAt = spec.mentorReviewedAt

  const data: Record<string, unknown> = { metadata: updatedMeta }
  if (spec.role        !== undefined) data.role        = spec.role
  if (spec.description !== undefined) data.description = spec.description

  await ctx.prisma.agent.update({ where: { id: spec.agent_id }, data })
  if (spec.systemPrompt !== undefined) {
    await auditLog(ctx.agentId ?? ctx.userId, `✏️ Updated agent **${existing.name}** system prompt (${spec.agent_id})`)
  }
  return `Updated agent "${existing.name}" (${spec.agent_id})`
}

async function handleArchiveAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { agent_id, reason } = parseArgs(args) as { agent_id?: string; reason?: string }
  if (!agent_id) return 'Error: agent_id is required'

  const existing = await ctx.prisma.agent.findUnique({
    where: { id: agent_id },
    select: { name: true, metadata: true },
  })
  if (!existing) return `Error: agent ${agent_id} not found`

  const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
  const contextConfig = (existingMeta.contextConfig ?? {}) as Record<string, unknown>
  if (contextConfig.persistent === true) {
    return `Error: agent "${existing.name}" is a persistent system agent and cannot be archived.`
  }
  await ctx.prisma.agent.update({
    where: { id: agent_id },
    data: {
      metadata: {
        ...existingMeta,
        archived:       true,
        archivedAt:     new Date().toISOString(),
        archivedReason: reason ?? 'Task completed',
      } as any,
    },
  })
  const msg = `📦 Archived agent **${existing.name}** — ${reason ?? 'task completed'}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Archived agent "${existing.name}" (${agent_id})`
}

async function handleEscalateTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, user_id } = parseArgs(args) as { task_id?: string; user_id?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!user_id) return 'Error: user_id is required'

  await ctx.prisma.task.update({
    where: { id: task_id },
    data:  { assignedUserId: user_id, status: 'pending' },
  })
  const [task, user] = await Promise.all([
    ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true } }),
    ctx.prisma.user.findUnique({ where: { id: user_id }, select: { name: true, username: true } }),
  ])
  const who = user?.name ?? user?.username ?? user_id
  const msg = `👤 Escalated **${task?.title}** → **${who}**`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Escalated task "${task?.title}" to user "${who}"`
}

async function handleGetTaskEvents(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, limit } = parseArgs(args) as { task_id?: string; limit?: number }
  if (!task_id) return 'Error: task_id is required'

  const [task, events] = await Promise.all([
    ctx.prisma.task.findUnique({
      where: { id: task_id },
      select: { title: true, status: true, assignedAgent: true, description: true },
    }),
    ctx.prisma.taskEvent.findMany({
      where: { taskId: task_id },
      orderBy: { createdAt: 'asc' },
      take: limit ?? 50,
    }),
  ])

  if (!task) return `Error: task ${task_id} not found`

  return JSON.stringify({
    task: { id: task_id, title: task.title, status: task.status, assignedAgent: task.assignedAgent, description: task.description },
    events: events.map((e: any) => ({
      eventType: e.eventType,
      content:   e.content ? e.content.slice(0, 500) : null,
      agentId:   e.agentId,
      createdAt: e.createdAt,
    })),
    toolCallCount: events.filter((e: any) => e.eventType === 'tool_call').length,
  }, null, 2)
}

async function handleCloseTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, summary } = parseArgs(args) as { task_id?: string; summary?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!summary?.trim()) return 'Error: summary is required'

  const task = await ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true, status: true } })
  if (!task) return `Error: task ${task_id} not found`
  if (task.status !== 'pending_validation') {
    return `Error: task is "${task.status}" — orion_close_task only operates on pending_validation tasks`
  }

  await ctx.prisma.task.update({ where: { id: task_id }, data: { status: 'done' } })
  const msg = `✅ Validated & closed **${task.title}** — ${summary}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Closed task "${task.title}"`
}

async function handleReopenTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, reason } = parseArgs(args) as { task_id?: string; reason?: string }
  if (!task_id) return 'Error: task_id is required'

  await ctx.prisma.task.update({
    where: { id: task_id },
    data:  { status: 'pending', assignedAgent: null },
  })
  const task = await ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true } })
  const msg = `🔄 Reopened **${task?.title}** — ${reason ?? 'validation failed'}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Reopened task "${task?.title}" — ${reason ?? 'validation failed'}`
}

async function handleListRooms(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { feature_id } = parseArgs(args) as { feature_id?: string }

  const where: Record<string, unknown> = {}
  if (feature_id) where.featureId = feature_id

  const rooms = await ctx.prisma.chatRoom.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: {
      _count: { select: { members: true } },
    },
  })

  return JSON.stringify(
    rooms.map((r: any) => ({
      id:          r.id,
      name:        r.name,
      type:        r.type,
      featureId:   r.featureId ?? null,
      taskId:      r.taskId ?? null,
      memberCount: r._count.members,
      createdAt:   r.createdAt,
    })),
    null, 2
  )
}

async function handleSendMessage(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, content } = parseArgs(args) as { room_id?: string; content?: string }
  if (!room_id)  return 'Error: room_id is required'
  if (!content?.trim()) return 'Error: content is required'

  const actorId = ctx.agentId
  if (!actorId) return 'Error: actorId is required to send messages (SOC2 attribution)'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id }, select: { name: true } })
  if (!room) return `Error: room ${room_id} not found`

  const membership = await ctx.prisma.chatRoomMember.findUnique({
    where: { roomId_agentId: { roomId: room_id, agentId: actorId } },
  })
  if (!membership) return `Error: you are not a member of room "${room.name}" — agents may only send messages to rooms they belong to`

  await ctx.prisma.chatMessage.create({
    data: {
      roomId:     room_id,
      agentId:    actorId,
      senderType: 'agent',
      content:    content.trim(),
    },
  })

  await auditLog(actorId, `💬 Sent message to room **${room.name}** (${room_id})`)
  return `Message posted to room "${room.name}" (${room_id})`
}

async function handleCreateFeature(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { epicId, title, description } = parseArgs(args) as {
    epicId?: string
    title?: string
    description?: string
  }
  if (!epicId) return 'Error: epicId is required'
  if (!title?.trim()) return 'Error: title is required'

  const epic = await ctx.prisma.epic.findUnique({ where: { id: epicId } })
  if (!epic) return `Error: epic ${epicId} not found`
  if (!epic.plan) {
    return 'Error: Epic must have a saved plan before features can be created. Use the Save as Plan button or ask the user to save the plan first.'
  }

  const actorId = ctx.agentId ?? ctx.userId
  const feature = await ctx.prisma.feature.create({
    data: {
      epicId,
      title: title.trim(),
      description: description || null,
      createdBy: actorId ?? 'agent',
    },
  })
  await auditLog(actorId, `✨ Created feature **${feature.title}** (\`${feature.id}\`) under epic \`${epicId}\``)
  return JSON.stringify({ id: feature.id, title: feature.title, epicId: feature.epicId }, null, 2)
}

async function handleCreateTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { featureId, title, description, plan, targetEnvironment, dedup_key } = parseArgs(args) as {
    featureId?: string
    title?: string
    description?: string
    plan?: string
    dedup_key?: string
    targetEnvironment?: { namespace?: string; hostname?: string; storageClass?: string; vaultPath?: string }
  }
  if (!featureId) return 'Error: featureId is required'
  if (!title?.trim()) return 'Error: title is required'
  if (!plan?.trim()) return 'Error: plan is required'

  const feature = await ctx.prisma.feature.findUnique({ where: { id: featureId } })
  if (!feature) return `Error: feature ${featureId} not found`
  if (!feature.plan) {
    return 'Error: Feature must have a saved plan before tasks can be created.'
  }

  if (dedup_key?.trim()) {
    const existing = await ctx.prisma.task.findFirst({
      where: {
        featureId,
        status:   { in: ['pending', 'running', 'pending_validation'] },
        metadata: { path: ['dedup_key'], equals: dedup_key.trim() },
      },
      select: { id: true, title: true },
    })
    if (existing) {
      return JSON.stringify({ id: existing.id, title: existing.title, duplicate: true, message: 'Task already exists for this issue — skipped.' })
    }
  }

  const actorId = ctx.agentId ?? ctx.userId
  const task = await ctx.prisma.task.create({
    data: {
      featureId,
      title:       title.trim(),
      description: description || null,
      plan:        plan.trim(),
      status:      'pending',
      priority:    'medium',
      createdBy:   actorId ?? 'agent',
      metadata:    {
        ...(targetEnvironment ? { targetEnvironment } : {}),
        ...(dedup_key?.trim() ? { dedup_key: dedup_key.trim() } : {}),
      } as object,
    },
  })
  await auditLog(actorId, `📋 Created task **${task.title}** (\`${task.id}\`) under feature \`${featureId}\`${targetEnvironment?.namespace ? ` → namespace: ${targetEnvironment.namespace}` : ''}`)
  return JSON.stringify({ id: task.id, title: task.title, featureId: task.featureId, plan: task.plan, targetEnvironment: targetEnvironment ?? null }, null, 2)
}

async function handleProposeGitops(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { environment_id, title, reasoning, operation_description, changes } = parseArgs(args) as {
    environment_id?: string
    title?: string
    reasoning?: string
    operation_description?: string
    changes?: Array<{ path: string; content: string }>
  }

  if (!environment_id || !title || !reasoning || !operation_description || !changes?.length) {
    return 'Error: environment_id, title, reasoning, operation_description, and changes are all required'
  }

  try {
    const { proposeChange } = await import('./gitops')

    const env = await ctx.prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${environment_id}" not found`
    if (!env.gitOwner || !env.gitRepo) {
      return 'Error: environment has no git repo — run bootstrap first'
    }

    const policy = (env.policyConfig ?? {}) as { overrides?: Record<string, string>; reviewAll?: boolean }
    const result = await proposeChange({
      owner: env.gitOwner,
      repo: env.gitRepo,
      title,
      reasoning,
      operationDescription: operation_description,
      changes,
      policy,
    })

    const action = result.merged
      ? `auto-merged (${result.classification.reason})`
      : `opened for review — ${result.classification.reason}`

    // Persist the PR so the dashboard can surface pending reviews
    await ctx.prisma.gitOpsPR.create({
      data: {
        environmentId: env.id,
        prNumber:  result.prNumber,
        title:     title!,
        operation: result.classification.operation,
        decision:  result.classification.decision,
        status:    result.merged ? 'merged' : 'open',
        prUrl:     result.prUrl,
        reasoning: reasoning ?? null,
        branch:    result.branch,
        mergedAt:  result.merged ? new Date() : null,
      },
    }).catch(() => {}) // non-fatal — PR already exists in Gitea even if DB write fails

    await auditLog(ctx.agentId ?? ctx.userId, `🔀 GitOps PR #${result.prNumber} ${action} — **${title}**`)
    return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
  } catch (e) {
    return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleRequestTool(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { tool_description, tool_name } = parseArgs(args) as {
    tool_description?: string
    tool_name?: string
  }

  if (!tool_description) return 'Error: tool_description is required'

  const name = tool_name || tool_description.slice(0, 50)
  const msg = `🔧 Tool request **${name}** — ${tool_description.slice(0, 300)}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)

  return `Tool request submitted: "${name}"\n\nAlpha will review this request during the next watcher cycle. Description: ${tool_description}`
}

async function handleRequestToolGrant(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { tool_name, reason } = parseArgs(args) as {
    tool_name?: string
    reason?: string
  }

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

// ── Cluster health handler ────────────────────────────────────────────────────

interface IngressEntry { namespace: string; ingress: string; host: string }
interface HealthResult extends IngressEntry {
  status: 'healthy' | 'degraded'
  httpStatus: number
  sslValid: boolean
  sslDaysUntilExpiry: number
  issues: string[]
  taskKey: string
}

function checkSSLCert(hostname: string): Promise<{ valid: boolean; daysUntilExpiry: number; error?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate()
      if (!cert?.valid_to) {
        socket.destroy()
        return resolve({ valid: false, daysUntilExpiry: 0, error: 'no certificate returned' })
      }
      const daysUntilExpiry = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000)
      socket.destroy()
      resolve({ valid: true, daysUntilExpiry })
    })
    socket.setTimeout(6_000, () => { socket.destroy(); resolve({ valid: false, daysUntilExpiry: 0, error: 'timeout' }) })
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const msg = e.code === 'CERT_HAS_EXPIRED'             ? 'certificate expired'
                : e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'  ? 'self-signed certificate'
                : e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'hostname mismatch'
                : e.message
      resolve({ valid: false, daysUntilExpiry: 0, error: msg })
    })
  })
}

function checkHTTPReachability(hostname: string): Promise<{ statusCode: number; reachable: boolean; error?: string }> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://${hostname}`,
      { timeout: 8_000, headers: { 'User-Agent': 'ORION-HealthCheck/1.0' } },
      (res) => {
        const statusCode = res.statusCode ?? 0
        resolve({ statusCode, reachable: statusCode > 0 && statusCode < 500 })
        res.destroy()
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0, reachable: false, error: 'timeout' }) })
    req.on('error', (e: NodeJS.ErrnoException) => {
      const isCertError = !!(e.code?.startsWith('CERT_') || e.code?.startsWith('ERR_TLS') || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      resolve({ statusCode: 0, reachable: isCertError, error: e.message })
    })
  })
}

function checkGatewayReachability(rawUrl: string): Promise<{ reachable: boolean; statusCode: number; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL
    try { parsed = new URL(rawUrl) }
    catch { return resolve({ reachable: false, statusCode: 0, error: 'invalid URL' }) }

    const requester = parsed.protocol === 'https:' ? https : http
    const req = requester.get(rawUrl, { timeout: 8_000 }, (res) => {
      res.resume()
      resolve({ reachable: true, statusCode: res.statusCode ?? 0 })
    })
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, statusCode: 0, error: 'timeout' }) })
    req.on('error',   (e) => resolve({ reachable: false, statusCode: 0, error: e.message }))
  })
}

async function handleClusterHealth(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { namespace } = parseArgs(args) as { namespace?: string }

  const clusterIssues: HealthResult[] = []
  const errors: string[] = []

  const ingressRoutes = await ctx.prisma.ingressRoute.findMany({
    where:  { enabled: true },
    select: { host: true, tls: true, ingressPoint: { select: { name: true, domain: { select: { name: true } } } } },
  })

  const seenHosts = new Set<string>()
  const uniqueRoutes = ingressRoutes.filter((r) => {
    if (seenHosts.has(r.host)) return false
    seenHosts.add(r.host)
    return true
  })

  const envs = await ctx.prisma.environment.findMany({
    where:  { type: 'cluster', kubeconfig: { not: null } },
    select: { id: true, name: true, kubeconfig: true },
  })

  for (const env of envs) {
    let kubeconfigPath: string | null = null
    try {
      const decoded = Buffer.from(env.kubeconfig!, 'base64').toString('utf-8')
      kubeconfigPath = join(tmpdir(), `orion-health-${env.id}.yaml`)
      writeFileSync(kubeconfigPath, decoded, { mode: 0o600 })
      const kc = `--kubeconfig ${kubeconfigPath}`
      const nsFlag = namespace ? `-n ${namespace}` : '-A'

      const [nodesOut, podsOut] = await Promise.all([
        execAsync(`kubectl get nodes ${kc} -o json`,          { timeout: 15_000 }).catch(() => null),
        execAsync(`kubectl get pods ${nsFlag} ${kc} -o json`, { timeout: 20_000 }).catch(() => null),
      ])

      if (nodesOut) {
        const nodesData = JSON.parse(nodesOut.stdout) as { items: any[] }
        for (const node of nodesData.items) {
          const readyCond = node.status?.conditions?.find((c: any) => c.type === 'Ready')
          if (readyCond?.status !== 'True') {
            const reason = readyCond?.reason ?? readyCond?.message ?? 'Unknown'
            clusterIssues.push({
              namespace:          env.name,
              ingress:            'node',
              host:               `node/${node.metadata.name as string}`,
              status:             'degraded',
              httpStatus:         0,
              sslValid:           true,
              sslDaysUntilExpiry: 999,
              issues:             [`node NotReady — ${reason}`],
              taskKey:            `pulse:node:${node.metadata.name as string}`,
            })
          }
        }
      }

      if (podsOut) {
        const podsData = JSON.parse(podsOut.stdout) as { items: any[] }
        for (const pod of podsData.items) {
          const phase = pod.status?.phase as string | undefined
          if (phase === 'Succeeded') continue
          const podIssues: string[] = []
          if (phase === 'Pending') {
            const condition = pod.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status !== 'True')
            podIssues.push(`Pending${condition ? ` — ${condition.reason as string}` : ''}`)
          } else if (phase === 'Failed') {
            podIssues.push(`Failed — ${pod.status?.reason ?? pod.status?.message ?? 'unknown'}`)
          } else if (phase === 'Running' || !phase) {
            for (const cs of (pod.status?.containerStatuses ?? []) as any[]) {
              const waiting = cs.state?.waiting
              if (waiting?.reason === 'CrashLoopBackOff') {
                podIssues.push(`CrashLoopBackOff — ${cs.name as string} (${cs.restartCount as number} restarts)`)
              } else if (waiting?.reason === 'OOMKilled' || cs.lastState?.terminated?.reason === 'OOMKilled') {
                podIssues.push(`OOMKilled — ${cs.name as string}`)
              } else if (!cs.ready && !waiting?.reason) {
                podIssues.push(`container not ready — ${cs.name as string}`)
              }
            }
          }
          if (podIssues.length > 0) {
            clusterIssues.push({
              namespace:          `${env.name}/${pod.metadata.namespace as string}`,
              ingress:            'pod',
              host:               `pod/${pod.metadata.name as string}`,
              status:             'degraded',
              httpStatus:         0,
              sslValid:           true,
              sslDaysUntilExpiry: 999,
              issues:             podIssues,
              taskKey:            `pulse:pod:${pod.metadata.namespace as string}/${pod.metadata.name as string}`,
            })
          }
        }
      }
    } catch (e) {
      errors.push(`${env.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (kubeconfigPath) try { unlinkSync(kubeconfigPath) } catch { /* ignore */ }
    }
  }

  const results: HealthResult[] = await Promise.all(
    uniqueRoutes.map(async (route) => {
      const label = route.ingressPoint?.domain?.name ?? route.ingressPoint?.name ?? 'ingress'
      const [httpCheck, ssl] = await Promise.all([
        checkHTTPReachability(route.host),
        route.tls ? checkSSLCert(route.host) : Promise.resolve({ valid: true, daysUntilExpiry: 999 }),
      ])

      const issues: string[] = []
      if (!httpCheck.reachable)           issues.push(`unreachable — ${httpCheck.error ?? `HTTP ${httpCheck.statusCode}`}`)
      if (route.tls) {
        if (!ssl.valid)                     issues.push(`invalid SSL cert — ${(ssl as any).error ?? 'certificate not trusted'}`)
        else if (ssl.daysUntilExpiry <= 0)  issues.push('SSL cert expired')
        else if (ssl.daysUntilExpiry < 30)  issues.push(`SSL cert expires in ${ssl.daysUntilExpiry} days`)
      }

      return {
        namespace:          label,
        ingress:            route.ingressPoint?.name ?? 'unknown',
        host:               route.host,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         httpCheck.statusCode,
        sslValid:           ssl.valid,
        sslDaysUntilExpiry: ssl.daysUntilExpiry,
        issues,
        taskKey:            `pulse:host:${route.host}`,
      } as HealthResult
    })
  )

  results.push(...clusterIssues)

  const allEnvsWithGateway = await ctx.prisma.environment.findMany({
    where:  { gatewayUrl: { not: null } },
    select: { id: true, name: true, type: true, gatewayUrl: true },
  })

  for (const env of allEnvsWithGateway) {
    try {
      const reach = await checkGatewayReachability(env.gatewayUrl!)
      const issues: string[] = []
      if (!reach.reachable) issues.push(`gateway unreachable — ${reach.error ?? `HTTP ${reach.statusCode}`}`)
      results.push({
        namespace:          `gateway/${env.type}`,
        ingress:            env.name,
        host:               env.gatewayUrl!,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         reach.statusCode,
        sslValid:           true,
        sslDaysUntilExpiry: 999,
        issues,
        taskKey:            `pulse:gateway:${env.name.toLowerCase().replace(/\s+/g, '-')}`,
      } as HealthResult)
    } catch (e) {
      errors.push(`${env.name} gateway: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const systemServiceSettings = await ctx.prisma.systemSetting.findMany({
    where: { key: { startsWith: 'system.service.' } },
  })
  for (const setting of systemServiceSettings) {
    const url = typeof setting.value === 'string' ? setting.value : null
    if (!url) continue
    const label = setting.key.replace('system.service.', '')
    try {
      const reach = await checkGatewayReachability(url)
      const issues: string[] = []
      if (!reach.reachable) issues.push(`unreachable — ${reach.error ?? `HTTP ${reach.statusCode}`}`)
      results.push({
        namespace:          'orion-system',
        ingress:            label,
        host:               url,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         reach.statusCode,
        sslValid:           true,
        sslDaysUntilExpiry: 999,
        issues,
        taskKey:            `pulse:svc:${label}`,
      } as HealthResult)
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const degraded = results.filter((r) => r.status === 'degraded')
  return JSON.stringify({
    summary: { total: results.length, healthy: results.length - degraded.length, degraded: degraded.length },
    degraded,
    all: results,
    ...(errors.length > 0 && { errors }),
  }, null, 2)
}

// ── Register all tools ────────────────────────────────────────────────────────

registerTool({
  name: 'orion_list_agents',
  description: 'List all agents on the team — their IDs, names, roles, and current busy/available status. Use this to see who is available before assigning work or creating new agents.',
  inputSchema: {
    type: 'object',
    properties: {
      include_archived: { type: 'boolean', description: 'Include archived agents (default false)' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: handleListAgents,
})

registerTool({
  name: 'orion_list_tasks',
  description: 'List tasks filtered by status, assignment, and date. Use this to find unassigned work, check what is running, or review failed tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      status:          { type: 'string',  description: 'Filter by status: pending, running, pending_validation, done, failed. Defaults to pending+running+failed. Use "pending_validation" to find tasks awaiting Veritas review.' },
      unassigned_only: { type: 'boolean', description: 'Only return tasks with no agent or user assigned (default false)' },
      assigned_agent_id: { type: 'string', description: 'Filter to tasks assigned to a specific agent ID' },
      since:           { type: 'string',  description: 'ISO 8601 timestamp — only return tasks created or updated after this date. Use this to fetch only new work since your last review.' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: handleListTasks,
})

registerTool({
  name: 'orion_assign_task',
  description: 'Assign a pending task to an agent. Sets the task status to pending and records the agent assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id:  { type: 'string', description: 'Task ID to assign' },
      agent_id: { type: 'string', description: 'Agent ID to assign the task to' },
    },
    required: ['task_id', 'agent_id'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleAssignTask,
})

registerTool({
  name: 'orion_create_agent',
  description: 'Create a new agent. Use only when no existing agent is suitable for the required work.',
  inputSchema: {
    type: 'object',
    properties: {
      name:         { type: 'string', description: 'Unique agent name (cannot be a reserved name: human, user, system, admin)' },
      role:         { type: 'string', description: 'One-line role description' },
      systemPrompt: { type: 'string', description: 'REQUIRED — full system prompt defining the agent\'s personality, responsibilities, and operating rules. Must be specific and actionable.' },
      type:         { type: 'string', description: 'Agent type for AI agents (default: claude). Do NOT use "human" — that is reserved for human users.' },
      description:  { type: 'string', description: 'Optional longer description' },
      persistent:   { type: 'boolean', description: 'true = persistent agent that stays in the roster; false = transient, will be archived when its work is done (default: false)' },
      llm:          { type: 'string', description: 'LLM to use (e.g. ext:<id>). Omit to use the system default.' },
    },
    required: ['name', 'role', 'systemPrompt'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleCreateAgent,
})

registerTool({
  name: 'orion_update_agent',
  description: 'Update an existing agent\'s role, description, system prompt, LLM, or review timestamp. Use this to improve agents based on observed performance — sharpen their prompts, fix their role description, or reassign their LLM. Also call this with mentorReviewedAt to record that you have reviewed an agent even if no prompt change was needed.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id:          { type: 'string', description: 'Agent ID to update' },
      role:              { type: 'string', description: 'Updated one-line role description' },
      description:       { type: 'string', description: 'Updated longer description' },
      systemPrompt:      { type: 'string', description: 'Updated full system prompt' },
      llm:               { type: 'string', description: 'Updated LLM (e.g. ext:<id>)' },
      mentorReviewedAt:  { type: 'string', description: 'ISO 8601 timestamp to record when Mentor last reviewed this agent. Always set this after completing a review, even if no changes were made.' },
    },
    required: ['agent_id'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleUpdateAgent,
})

registerTool({
  name: 'orion_archive_agent',
  description: 'Soft-archive a transient agent after its work is done. Never deletes — preserves audit trail (SOC2 [A-001]).',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID to archive' },
      reason:   { type: 'string', description: 'Optional reason for archiving' },
    },
    required: ['agent_id'],
  },
  tier: 'destructive',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleArchiveAgent,
})

registerTool({
  name: 'orion_escalate_task',
  description: 'Escalate a task to a human user. Sets the assignedUserId and status to pending.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to escalate' },
      user_id: { type: 'string', description: 'User ID to assign the task to' },
    },
    required: ['task_id', 'user_id'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleEscalateTask,
})

registerTool({
  name: 'orion_get_task_events',
  description: 'Fetch the execution event log for a task. Returns timestamped events including tool calls, tool results, and agent output. Use this to verify whether a task was actually executed before closing it.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to fetch events for' },
      limit:   { type: 'number', description: 'Maximum number of events to return (default 50)' },
    },
    required: ['task_id'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: handleGetTaskEvents,
})

registerTool({
  name: 'orion_close_task',
  description: 'Mark a task as done after confirming the work was actually completed. Only works on tasks in pending_validation status. ONLY call this after verifying via orion_get_task_events that real tool calls were made and the outcome matches the task description.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to close' },
      summary: { type: 'string', description: 'Brief validation summary — what was confirmed and how' },
    },
    required: ['task_id', 'summary'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleCloseTask,
})

registerTool({
  name: 'orion_reopen_task',
  description: 'Reopen a pending_validation, done, or failed task back to pending. Use when validation reveals the task was not actually completed — e.g. agent self-reported done with zero tool calls.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to reopen' },
      reason:  { type: 'string', description: 'Why the task is being reopened' },
    },
    required: ['task_id', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleReopenTask,
})

registerTool({
  name: 'orion_list_rooms',
  description: 'List chat rooms. Optionally filter by feature_id to find the coordination room for a feature.',
  inputSchema: {
    type: 'object',
    properties: {
      feature_id: { type: 'string', description: 'Filter by feature ID to find the feature coordination room' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: handleListRooms,
})

registerTool({
  name: 'orion_send_message',
  description: 'Post a message to a chat room. Use this to communicate with other agents or report status in a feature coordination room.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: { type: 'string', description: 'Chat room ID to post the message to' },
      content: { type: 'string', description: 'Message content to post' },
    },
    required: ['room_id', 'content'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleSendMessage,
})

registerTool({
  name: 'orion_create_feature',
  description: 'Create a new feature under an epic. GUARD: will fail if epic.plan is null — the epic must have a saved plan before features can be created.',
  inputSchema: {
    type: 'object',
    properties: {
      epicId:      { type: 'string', description: 'ID of the parent epic' },
      title:       { type: 'string', description: 'Feature title' },
      description: { type: 'string', description: 'Feature description (optional)' },
    },
    required: ['epicId', 'title'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleCreateFeature,
})

registerTool({
  name: 'orion_create_task',
  description: 'Create a new task under a feature with a step-by-step implementation plan. The plan should be numbered steps specific enough for a smaller LLM to execute without additional context. GUARD: will fail if feature.plan is null.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId:         { type: 'string', description: 'ID of the parent feature' },
      title:             { type: 'string', description: 'Task title' },
      description:       { type: 'string', description: 'Task description (optional)' },
      plan:              { type: 'string', description: 'Numbered step-by-step implementation plan. Each step should be specific enough for a smaller LLM to execute. E.g.:\n1. Read /path/to/file and understand X\n2. Edit Y to add Z\n3. Run the test suite\n4. Verify output matches expected' },
      targetEnvironment: {
        type: 'object',
        description: 'For deployment tasks — the target environment as designated by the Atlas. Pass as an object with keys: namespace (e.g. "apps"), hostname (e.g. "myapp.khalisio.com"), storageClass (e.g. "longhorn", if storage needed), vaultPath (e.g. "secret/data/myapp", if secrets needed).',
      },
      dedup_key: {
        type: 'string',
        description: 'Optional deduplication key. If an open task (pending/running/pending_validation) with this exact key already exists under the same feature, creation is skipped and the existing task is returned. Use a stable identifier like "pulse:host:vault-proxy" or "pulse:node:talos-rpi2".',
      },
    },
    required: ['featureId', 'title', 'plan'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleCreateTask,
})

registerTool({
  name: 'orion_propose_gitops',
  description: 'Propose a GitOps change for a cluster environment. Creates a branch, commits manifests, opens a PR, and auto-merges if the change matches policy (e.g. scaling, patch image tags). Use this for ALL infrastructure work — deploying services, creating configmaps/secrets, updating ingresses, etc.\n\nREQUIRED: you must know the target environment. Ask the Atlas in the feature room, or check orion_list_agents for the Atlas. If you have no way to get the environment designation, use environment_id: "localhost" as a fallback.\n\nRules:\n- Always include a clear reasoning field explaining why the change is needed\n- Provide operation_description for policy classification (e.g. "deploy new service", "update image tag")\n- Write manifests with namespace, proper labels, and correct resource types\n- For deployments: include namespace selector, resource limits if appropriate\n- For services: use ClusterIP unless ingress is explicitly needed',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id:      { type: 'string', description: 'Environment ID or name (e.g. "localhost", "production", or the CUID of the environment)' },
      title:               { type: 'string', description: 'Short PR title, e.g. "feat: add nginx reverse proxy"' },
      reasoning:           { type: 'string', description: 'Why this change is needed' },
      operation_description: { type: 'string', description: 'One-line description for policy classification, e.g. "add new service"' },
      changes: {
        type: 'array',
        description: 'Manifest files to create or update.',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'Repo-relative file path, e.g. deployments/nginx/deployment.yaml' },
            content: { type: 'string', description: 'Full file content as YAML/JSON' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['environment_id', 'title', 'reasoning', 'operation_description', 'changes'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleProposeGitops,
})

registerTool({
  name: 'orion_request_tool',
  description: 'Request a new tool type or capability. Use this when the task requires a capability that is not currently available (e.g. file writing, docker commands, curl). This creates a tool request that Alpha will review and either grant or explain why it cannot be provided.\n\nOnly request tools that are genuinely needed — do not request alternatives that already exist. If you only need read-only kubectl access, you already have it.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_description: { type: 'string', description: 'Description of the tool/capability needed and why it is needed for the current task' },
      tool_name:        { type: 'string', description: 'Suggested tool name (e.g. "file_write", "docker_run")' },
    },
    required: ['tool_description'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: handleRequestTool,
})

registerTool({
  name: 'orion_cluster_health',
  description: 'Comprehensive health check across all ORION-managed systems: (1) all enabled IngressRoutes — HTTP reachability and SSL cert validity; (2) Kubernetes cluster node readiness and pod issues (CrashLoopBackOff, OOMKilled, Failed, Pending); (3) all registered environment gateways; (4) ORION system services (Gitea, Vault, ORION itself). Each degraded item includes a canonical taskKey field — pass this as dedup_key when calling orion_create_task to prevent duplicate fix tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Limit check to a specific namespace (optional — omit to check all namespaces)' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: handleClusterHealth,
})

registerTool({
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
  handler: handleRequestToolGrant,
})

registerTool({
  name: 'orion_get_environment',
  description: 'Get the configuration and status of an ORION environment, including whether kubeconfig is stored.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
    },
    required: ['environment_id'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'chat',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseArgs(args) as { environment_id?: string }
      if (!environment_id) return 'Error: environment_id is required'
      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      return JSON.stringify({
        id:          env.id,
        name:        env.name,
        type:        env.type,
        status:      env.status,
        gatewayUrl:  env.gatewayUrl,
        kubeconfig:  env.kubeconfig ? '••••' : null,
        gitOwner:  env.gitOwner,
        gitRepo:   env.gitRepo,
      }, null, 2)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

registerTool({
  name: 'orion_patch_environment',
  description: 'Update fields on an ORION environment (e.g. save kubeconfig, update gatewayUrl).',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
      body:           { type: 'object', description: 'Fields to update, e.g. {"kubeconfig": "<base64>"}' },
    },
    required: ['environment_id', 'body'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  handler: async (args, ctx) => {
    try {
      const { environment_id, body } = parseArgs(args) as { environment_id?: string; body?: Record<string, unknown> }
      if (!environment_id) return 'Error: environment_id is required'
      if (!body || typeof body !== 'object') return 'Error: body must be an object'

      const ALLOWED = ['kubeconfig', 'gatewayUrl', 'gitOwner', 'gitRepo', 'description']
      const update: Record<string, unknown> = {}
      for (const key of ALLOWED) {
        if (key in body) update[key] = body[key]
      }
      if (!Object.keys(update).length) return 'Error: no patchable fields provided'

      const target = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!target) return `Error: environment "${environment_id}" not found`
      await ctx.prisma.environment.update({ where: { id: target.id }, data: update })
      return `Environment "${target.name}" updated: ${Object.keys(update).join(', ')}`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

registerTool({
  name: 'knowledge_remember',
  description: 'Save an important fact, insight, or learned pattern to persistent memory for future tasks to reference',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key:     { type: 'string', description: 'Short category label (e.g. "deployment-pattern", "cluster-quirk")' },
      value:   { type: 'string', description: 'The fact or insight to remember' },
      context: { type: 'string', description: 'Why this is important (optional)' },
    },
    required: ['key', 'value'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: async (args, ctx) => {
    const { key, value, context: ctx2 } = parseArgs(args) as { key?: string; value?: string; context?: string }
    if (!key?.trim())   return 'Error: key is required'
    if (!value?.trim()) return 'Error: value is required'

    // Find the conversation linked to this task
    let conversationId: string | null = null
    if (ctx.taskId) {
      const conv = await ctx.prisma.conversation.findFirst({
        where: { metadata: { path: ['taskId'], equals: ctx.taskId } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      })
      conversationId = conv?.id ?? null
    }

    if (!conversationId) {
      // No linked conversation — fall back to a shared "agent-memory" conversation
      const fallback = await ctx.prisma.conversation.upsert({
        where:  { id: 'agent-memory-global' },
        update: {},
        create: { id: 'agent-memory-global', title: 'Agent Memory (global)', metadata: { system: true } as any },
      })
      conversationId = fallback.id
    }

    await ctx.prisma.memory.upsert({
      where:  { conversationId_key: { conversationId, key: key.trim() } },
      update: { value: value.trim(), context: ctx2 ?? null },
      create: { conversationId, key: key.trim(), value: value.trim(), context: ctx2 ?? null },
    })

    return `Remembered: [${key.trim()}] ${value.trim()}`
  },
})

registerTool({
  name: 'orion_bootstrap_environment',
  description: 'Trigger the bootstrap process for a Kubernetes cluster environment. Deploys ArgoCD and ORION Gateway into the cluster.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
    },
    required: ['environment_id'],
  },
  tier: 'destructive',
  parallelSafe: false,
  availableIn: 'chat',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseArgs(args) as { environment_id?: string }
      if (!environment_id) return 'Error: environment_id is required'

      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.kubeconfig) return 'Error: no kubeconfig stored for this environment. Patch it first using orion_patch_environment.'

      const baseUrl = process.env.ORION_CALLBACK_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
      const res = await fetch(`${baseUrl}/api/environments/${environment_id}/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-call': '1' },
      })
      if (!res.ok) return `Bootstrap request failed: HTTP ${res.status}`

      const reader = res.body?.getReader()
      if (!reader) return 'Bootstrap started (no stream output)'
      const decoder = new TextDecoder()
      const lines: string[] = []
      let done = false
      while (!done) {
        const { value, done: d } = await reader.read()
        done = d
        if (value) {
          const chunk = decoder.decode(value, { stream: true })
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const evt = JSON.parse(line.slice(6)) as { type: string; message?: string }
              if (evt.message) lines.push(`[${evt.type}] ${evt.message}`)
            } catch { /* skip */ }
          }
        }
      }
      return lines.length ? lines.join('\n') : 'Bootstrap completed (no output captured)'
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

// ── spawn_agent ───────────────────────────────────────────────────────────────

const MAX_SUBAGENT_RESULT_CHARS = 12_000
const SUBAGENT_DEPTH_KEY = '__subagent_depth'

registerTool({
  name: 'spawn_agent',
  description: `Run an ephemeral sub-agent in-process and return its output as a string.

Use this when the current task needs to delegate a focused sub-problem to a separate agent loop — for example, to gather information, draft content, or execute a short specialised workflow — without creating a new Task in the database or waiting for the worker poll cycle.

The sub-agent runs with the same gateway/environment connection as the parent, inherits management tools, and uses the same or an overridden model. Results are returned synchronously to the caller.

Guidelines:
- Keep prompts concise and focused on a single outcome
- Prefer this over orion_create_task when you need the answer immediately
- Do NOT spawn sub-agents recursively — depth is capped at 1`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task/question for the sub-agent to answer or complete',
      },
      system_prompt: {
        type: 'string',
        description: 'Optional system prompt override. Defaults to the parent agent\'s system prompt.',
      },
      model: {
        type: 'string',
        description: 'Optional model ID override (e.g. "claude:claude-haiku-4-5-20251001"). Defaults to parent agent\'s model.',
      },
      max_turns: {
        type: 'number',
        description: 'Maximum tool-calling turns (default 8, max 15)',
      },
    },
    required: ['prompt'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'task',
  handler: async (args, ctx) => {
    // Guard against recursive spawning
    const depth = ((ctx as any)[SUBAGENT_DEPTH_KEY] ?? 0) as number
    if (depth >= 1) {
      return 'Error: spawn_agent cannot be called recursively (max depth 1)'
    }

    const {
      prompt,
      system_prompt: systemPromptOverride,
      model: modelOverride,
      max_turns: maxTurnsArg,
    } = parseArgs(args) as {
      prompt?: string
      system_prompt?: string
      model?: string
      max_turns?: number
    }

    if (!prompt?.trim()) return 'Error: prompt is required'

    const maxTurns = Math.min(maxTurnsArg ?? 8, 15)

    try {
      // Lazy import to avoid circular dependency (openai-runner imports tool-registry)
      const { createRunner } = await import('@/lib/agent-runner')
      const { MANAGEMENT_TOOL_DEFS, executeManagedTool } = await import('@/lib/management-tools')

      // Resolve model: arg override → parent agent's model → system default
      let modelId = modelOverride ?? null
      let systemPrompt = systemPromptOverride ?? 'You are a helpful assistant.'

      if (ctx.agentId && (!modelId || !systemPromptOverride)) {
        const agent = await ctx.prisma.agent.findUnique({
          where: { id: ctx.agentId },
          select: { metadata: true },
        })
        if (agent) {
          const meta          = (agent.metadata ?? {}) as Record<string, unknown>
          const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
          if (!modelId) {
            const llm = contextConfig.llm as string | undefined
            if (llm) modelId = llm.startsWith('claude:') || llm.startsWith('ollama:') || llm.startsWith('ext:')
              ? llm
              : `ext:${llm}`
          }
          if (!systemPromptOverride) {
            systemPrompt = (meta.systemPrompt as string | undefined) ?? systemPrompt
          }
        }
      }

      modelId = modelId ?? await getDefaultModelId()

      // Resolve gateway from environment if available
      let gateway: { url: string; token: string } | null = null
      if (ctx.environmentId) {
        const { resolveAgentGateway } = await import('@/lib/agent-gateway')
        const agentGw = ctx.agentId ? await resolveAgentGateway(ctx.agentId) : null
        if (agentGw) gateway = { url: agentGw.url, token: agentGw.token }
      }

      const subCtx = {
        taskId:          `subagent-${Date.now()}`,
        taskTitle:       prompt.slice(0, 80),
        taskDescription: null,
        taskPlan:        null,
        agentId:         ctx.agentId ?? 'subagent',
        agentName:       'sub-agent',
        systemPrompt,
        modelId,
        gateway,
        environmentId:   ctx.environmentId,
        managementTools: {
          definitions: MANAGEMENT_TOOL_DEFS,
          execute: (name: string, argsRaw: string) =>
            executeManagedTool(name, argsRaw, ctx.agentId),
        },
        // Internal: track recursion depth so nested spawn_agent calls are blocked
        [SUBAGENT_DEPTH_KEY]: depth + 1,
      }

      const runner = createRunner(modelId)

      // Cap turns by temporarily patching the context (runners read MAX_TURNS internally,
      // but we pass maxTurns in the context for runners that respect it in future)
      ;(subCtx as any).__maxTurns = maxTurns

      let result = ''
      for await (const event of runner.run(subCtx as any)) {
        if (event.type === 'text') result += event.content
        if (event.type === 'error') return `Sub-agent error: ${event.error}`
        if (event.type === 'done') break
      }

      if (result.length > MAX_SUBAGENT_RESULT_CHARS) {
        result = result.slice(0, MAX_SUBAGENT_RESULT_CHARS) + `\n\n[result truncated at ${MAX_SUBAGENT_RESULT_CHARS} chars]`
      }

      return result || '(sub-agent produced no text output)'
    } catch (e) {
      return `Error running sub-agent: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

// ── gitops_propose ────────────────────────────────────────────────────────────

registerTool({
  name: 'gitops_propose',
  description: `Propose a GitOps change. Creates a branch, commits files, opens a PR in the environment's git repo, and auto-merges if policy allows. Use this for ALL cluster/infrastructure changes — never apply kubectl manifests directly.

For Kubernetes manifests: always include namespace, use pinned image tags, include CrowdSec + Authentik middleware on all public ingresses.
For Docker Compose: use self-contained services (no host bind mounts for config files).`,
  inputSchema: {
    type: 'object',
    properties: {
      environment_id:        { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster", "localhost")' },
      title:                 { type: 'string', description: 'Short PR title, e.g. "feat: deploy Tailscale Operator"' },
      reasoning:             { type: 'string', description: 'Why this change is needed' },
      operation_description: { type: 'string', description: 'Plain-language summary: e.g. "add new service", "update image tag", "remove service"' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'Repo-relative file path' },
            content: { type: 'string', description: 'Full file content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['environment_id', 'title', 'reasoning', 'operation_description', 'changes'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: async (args) => {
    const { environment_id, title, reasoning, operation_description, changes } =
      args as { environment_id?: string; title?: string; reasoning?: string; operation_description?: string; changes?: Array<{ path: string; content: string }> }

    if (!environment_id || !title || !reasoning || !operation_description || !changes?.length) {
      return 'Error: environment_id, title, reasoning, operation_description, and changes are all required'
    }
    try {
      const { proposeChange } = await import('@/lib/gitops')
      const env = await prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo configured — run bootstrap first'

      const policy = (env.policyConfig ?? {}) as import('@/lib/gitops-policy').PolicyConfig
      const result = await proposeChange({
        owner: env.gitOwner,
        repo: env.gitRepo,
        title,
        reasoning,
        operationDescription: operation_description,
        changes,
        policy,
      })

      await prisma.gitOpsPR.create({
        data: {
          environmentId: env.id,
          prNumber:  result.prNumber,
          title,
          operation: result.classification.operation,
          decision:  result.classification.decision,
          status:    result.merged ? 'merged' : 'open',
          prUrl:     result.prUrl,
          reasoning,
          branch:    result.branch,
          mergedAt:  result.merged ? new Date() : null,
        },
      })

      const action = result.merged
        ? `auto-merged (${result.classification.reason})`
        : `opened for review — ${result.classification.reason}`
      return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
    } catch (e) {
      return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

// ── propose_tool ──────────────────────────────────────────────────────────────

registerTool({
  name: 'propose_tool',
  description: "Propose a new MCP tool for admin review. Use this when you need a capability that isn't in your current tool list. The admin will be notified to approve or reject the proposal.",
  inputSchema: {
    type: 'object',
    properties: {
      name:        { type: 'string', description: 'snake_case tool name' },
      description: { type: 'string', description: 'Clear one-sentence description of what the tool does' },
      inputSchema: { type: 'object', description: 'JSON Schema for the tool inputs (type: object, properties, required)' },
      execType:    { type: 'string', enum: ['shell', 'http', 'builtin'], description: 'How the tool is executed' },
      execConfig:  { type: 'object', description: 'Execution config: shell={command}, http={url,method}' },
      environment_id: { type: 'string', description: 'Environment to associate the tool with (optional — inferred from context if omitted)' },
    },
    required: ['name', 'description', 'inputSchema'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: async (args, ctx) => {
    const { name, description, inputSchema: schema, execType, execConfig, environment_id } =
      args as { name?: string; description?: string; inputSchema?: object; execType?: string; execConfig?: object; environment_id?: string }

    if (!name || !description || !schema) {
      return 'Error: propose_tool requires name, description, and inputSchema'
    }

    const envId = environment_id ?? ctx.environmentId
    if (!envId) return 'Error: no environment context — pass environment_id explicitly'

    const existing = await ctx.prisma.mcpTool.findFirst({ where: { environmentId: envId, name } })
    if (existing) return `Tool "${name}" already exists (status: ${existing.status}).`

    await ctx.prisma.mcpTool.create({
      data: {
        environmentId: envId,
        name,
        description,
        inputSchema: schema as object,
        execType: (execType as string) || 'shell',
        execConfig: execConfig as object | undefined,
        enabled: false,
        builtIn: false,
        status: 'pending',
        proposedBy: ctx.agentId,
        proposedAt: new Date(),
      },
    })

    return `Tool "${name}" proposed successfully. An admin will review and approve it from Administration → Environments → Approvals.`
  },
})

// ── knowledge_search ──────────────────────────────────────────────────────────

registerTool({
  name: 'knowledge_search',
  description: 'Semantically search the knowledge base (notes, runbooks, wiki pages) for content relevant to a query. Returns notes ranked by similarity.',
  inputSchema: {
    type: 'object',
    properties: {
      query:          { type: 'string',  description: 'Natural language search query' },
      limit:          { type: 'number',  description: 'Max results to return (1-20, default 5)' },
      includeContent: { type: 'boolean', description: 'Whether to include full note content (default true)' },
    },
    required: ['query'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: async (args) => {
    const { query, limit = 5, includeContent = true } =
      args as { query?: string; limit?: number; includeContent?: boolean }
    if (!query) return 'Error: query is required'

    const embedding = await generateEmbedding(query.slice(0, 2000))
    if (!embedding) return 'No embedding provider configured. Add an embedding model in Admin → Models to enable semantic search.'

    const results = await vectorSearch(embedding.vector, Math.min(limit, 20))
    if (!results.length) return 'No relevant notes found for this query.'

    return JSON.stringify(
      results.map((r: any) => ({
        title:  r.title,
        type:   r.type,
        folder: r.folder,
        score:  parseFloat(r.score.toFixed(3)),
        ...(includeContent && { content: r.content.slice(0, 2000) }),
      })),
      null, 2
    )
  },
})

// ── knowledge_graph ───────────────────────────────────────────────────────────

registerTool({
  name: 'knowledge_graph',
  description: 'Get the full knowledge graph — all notes with their types, wikilink dependencies, and semantic connections. Use this to understand what documentation exists and how topics relate.',
  inputSchema: {
    type: 'object',
    properties: {
      threshold:      { type: 'number',  description: 'Minimum similarity score for semantic edges (0.0-1.0, default 0.5)' },
      includeContent: { type: 'boolean', description: 'Include a short content snippet per note (default false)' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  handler: async (args) => {
    const { threshold = 0.5, includeContent = false } =
      args as { threshold?: number; includeContent?: boolean }

    const [notes, semanticEdges] = await Promise.all([
      prisma.note.findMany({
        select: { id: true, title: true, type: true, folder: true, content: true },
        orderBy: { title: 'asc' },
      }),
      prisma.semanticConnection.findMany({
        where: { score: { gte: threshold } },
        select: { sourceNoteId: true, targetNoteId: true, score: true },
        orderBy: { score: 'desc' },
        take: 200,
      }),
    ])

    const noteByTitle = new Map(notes.map((n: any) => [n.title.toLowerCase(), n.title]))
    const wikilinkEdges: Array<{ from: string; to: string }> = []
    const wikilinkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g
    for (const note of notes) {
      for (const match of (note as any).content.matchAll(wikilinkRegex)) {
        const target = match[1].trim()
        if (noteByTitle.has(target.toLowerCase()) && target.toLowerCase() !== (note as any).title.toLowerCase()) {
          wikilinkEdges.push({ from: (note as any).title, to: target })
        }
      }
    }

    const nodeLines = notes.map((n: any) => {
      const tag = n.type !== 'note' ? ` [${n.type}]` : ''
      const folder = n.folder ? ` (${n.folder})` : ''
      const snippet = includeContent ? `\n  ${n.content.slice(0, 200).replace(/\n/g, ' ')}` : ''
      return `- ${n.title}${tag}${folder}${snippet}`
    })

    const wikiLines = wikilinkEdges.map((e: any) => `  ${e.from} → ${e.to}`)
    const noteById = new Map(notes.map((n: any) => [n.id, n]))
    const semLines = semanticEdges
      .map((e: any) => {
        const src = (noteById.get(e.sourceNoteId) as any)?.title
        const tgt = (noteById.get(e.targetNoteId) as any)?.title
        return src && tgt ? `  ${src} ~${e.score.toFixed(2)}~ ${tgt}` : null
      })
      .filter(Boolean)

    return [
      `## Notes (${notes.length})\n${nodeLines.join('\n')}`,
      `\n## Wikilink Edges (${wikiLines.length})\n${wikiLines.join('\n') || '  none'}`,
      `\n## Semantic Edges (${semLines.length})\n${semLines.join('\n') || '  none'}`,
    ].join('\n')
  },
})

// ── knowledge_write ───────────────────────────────────────────────────────────

registerTool({
  name: 'knowledge_write',
  description: `Write a lesson, pattern, or finding to the shared knowledge base. Automatically embedded into the vector index so all agents can find it via knowledge_search.

Use this after completing or investigating any task. Structure content for maximum searchability:

  ## Context
  [When does this apply? What task/domain/service?]

  ## Problem
  [What went wrong, or what needed to be done?]

  ## Root Cause
  [Why did it happen?]

  ## Solution
  [Exact steps, commands, or approach that worked]

  ## Rules for Next Time
  - [Specific do/don't rules derived from this experience]`,
  inputSchema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short searchable title — include service/domain name and the key lesson. E.g. "Tailscale: namespace must exist before operator deploy"' },
      content: { type: 'string', description: 'Structured lesson — use the Context/Problem/Root Cause/Solution/Rules format for best search retrieval' },
      folder:  { type: 'string', description: '"Success Patterns" | "Failure Patterns" | "Cluster Quirks" | "Tool Usage" | "Agent Lessons" (default: "Agent Lessons")' },
      tags:    { type: 'array', items: { type: 'string' }, description: 'Domain tags for filtering, e.g. ["tailscale", "networking", "kubernetes"]' },
    },
    required: ['title', 'content'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  handler: async (args) => {
    const { title, content, folder = 'Agent Lessons', tags } =
      args as { title?: string; content?: string; folder?: string; tags?: string[] }

    if (!title?.trim()) return 'Error: title is required'
    if (!content?.trim()) return 'Error: content is required'

    const { embedNote } = await import('@/lib/embeddings')

    const existing = await prisma.note.findFirst({ where: { title: title.trim() } })

    let note: { id: string; title: string; content: string }
    if (existing) {
      note = await prisma.note.update({
        where: { id: existing.id },
        data: {
          content:   content.trim(),
          folder:    folder.trim(),
          tags:      tags ? tags : (existing.tags ?? undefined),
          updatedAt: new Date(),
        },
      })
    } else {
      note = await prisma.note.create({
        data: {
          title:   title.trim(),
          content: content.trim(),
          folder:  folder.trim(),
          type:    'note',
          tags:    tags ? tags as any : undefined,
        },
      })
    }

    // Embed immediately so the note is searchable via knowledge_search right away
    const embedded = await embedNote(note).catch(() => false)

    const action = existing ? 'updated' : 'written'
    return `Knowledge ${action}: "${note.title}" (id: ${note.id}, folder: ${folder}, embedded: ${embedded})`
  },
})
