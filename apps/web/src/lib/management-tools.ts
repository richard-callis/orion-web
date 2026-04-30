/**
 * Shared management tool definitions and dispatcher.
 *
 * These tools cover agent/task coordination and are available in all runner modes
 * (watcher, openai-runner, ollama-runner). Chat-specific tools (environment,
 * gitops, knowledge) remain in claude.ts.
 *
 * SOC2 [A-001]: every write is attributed to the caller via actorId and logged to
 * the agent-feed audit trail.
 */

import type { ManagementToolDef } from '@/lib/agent-runner/types'
import { prisma } from '@/lib/db'
import { getDefaultModelId } from '@/lib/default-model'

// SOC2 [INPUT-001]: mirrors the reserved-name check in POST /api/agents
export const RESERVED_AGENT_NAMES = ['human', 'user', 'system', 'admin']

// ── Tool definitions ──────────────────────────────────────────────────────────

export const MANAGEMENT_TOOL_DEFS: ManagementToolDef[] = [
  {
    name: 'orion_list_agents',
    description: 'List all agents on the team — their IDs, names, roles, and current busy/available status. Use this to see who is available before assigning work or creating new agents.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', description: 'Include archived agents (default false)' },
      },
    },
  },
  {
    name: 'orion_list_tasks',
    description: 'List tasks filtered by status and assignment. Use this to find unassigned work, check what is running, or review failed tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        status:          { type: 'string',  description: 'Filter by status: pending, running, pending_validation, done, failed. Defaults to pending+running+failed. Use "pending_validation" to find tasks awaiting Validator review.' },
        unassigned_only: { type: 'boolean', description: 'Only return tasks with no agent or user assigned (default false)' },
      },
    },
  },
  {
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
  },
  {
    name: 'orion_create_agent',
    description: 'Create a new agent. Use only when no existing agent is suitable for the required work.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Unique agent name (cannot be a reserved name: human, user, system, admin)' },
        role:        { type: 'string', description: 'One-line role description' },
        type:        { type: 'string', description: 'Agent type for AI agents (default: claude). Do NOT use "human" — that is reserved for human users.' },
        description: { type: 'string', description: 'Optional longer description' },
        metadata: {
          type: 'object',
          description: 'Optional metadata including systemPrompt and contextConfig. E.g. {"systemPrompt":"...","contextConfig":{"persistent":false}}',
        },
      },
      required: ['name', 'role'],
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
]

// ── Audit helper ──────────────────────────────────────────────────────────────

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

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListAgents(argsRaw: string): Promise<string> {
  const { include_archived } = JSON.parse(argsRaw || '{}') as { include_archived?: boolean }
  const agents = await prisma.agent.findMany({
    orderBy: { name: 'asc' },
    include: { tasks: { where: { status: 'running' }, select: { id: true }, take: 1 } },
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

async function handleListTasks(argsRaw: string): Promise<string> {
  const { status, unassigned_only } = JSON.parse(argsRaw || '{}') as {
    status?: string | string[]
    unassigned_only?: boolean
  }
  const statuses = status
    ? (Array.isArray(status) ? status : [status])
    : ['pending', 'running', 'failed']
  const tasks = await prisma.task.findMany({
    where: {
      status: { in: statuses as any },
      ...(unassigned_only ? { assignedAgent: null, assignedUserId: null } : {}),
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

async function handleAssignTask(argsRaw: string, actorId?: string): Promise<string> {
  const { task_id, agent_id } = JSON.parse(argsRaw || '{}') as { task_id?: string; agent_id?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!agent_id) return 'Error: agent_id is required'

  await prisma.task.update({
    where: { id: task_id },
    data:  { assignedAgent: agent_id, status: 'pending' },
  })
  const [task, agent] = await Promise.all([
    prisma.task.findUnique({ where: { id: task_id }, select: { title: true } }),
    prisma.agent.findUnique({ where: { id: agent_id }, select: { name: true } }),
  ])
  const msg = `📋 Assigned **${task?.title}** → **${agent?.name}**`
  await auditLog(actorId, msg)
  return `Assigned task "${task?.title}" to agent "${agent?.name}"`
}

async function handleCreateAgent(argsRaw: string, actorId?: string): Promise<string> {
  const spec = JSON.parse(argsRaw || '{}') as {
    name?: string
    role?: string
    type?: string
    description?: string
    metadata?: Record<string, unknown>
  }

  if (!spec.name?.trim()) return 'Error: name is required'
  if (!spec.role?.trim()) return 'Error: role is required'

  // SOC2 [INPUT-001]: reserved name guard
  if (RESERVED_AGENT_NAMES.includes(spec.name.toLowerCase())) {
    await auditLog(actorId, `⚠️ Cannot create agent: **${spec.name}** is a reserved name`)
    return `Error: "${spec.name}" is a reserved agent name`
  }

  // Resolve default LLM so created agents don't fall back to Claude Code SDK
  const defaultLlm = await getDefaultModelId()
  const incomingMeta   = (spec.metadata ?? {}) as Record<string, unknown>
  const incomingCfg    = (incomingMeta.contextConfig ?? {}) as Record<string, unknown>
  const contextConfig  = { ...incomingCfg, llm: incomingCfg.llm ?? defaultLlm }
  const mergedMetadata = { ...incomingMeta, contextConfig }

  const created = await prisma.agent.create({
    data: {
      name:        spec.name.trim(),
      type:        (spec.type && spec.type !== 'human') ? spec.type : 'claude',
      role:        spec.role ?? null,
      description: spec.description ?? null,
      metadata:    mergedMetadata as any,
    },
  })
  const msg = `🤖 Created agent **${created.name}** (\`${created.id}\`) — ${created.role ?? 'no role'}`
  await auditLog(actorId, msg)
  return JSON.stringify({ id: created.id, name: created.name, role: created.role }, null, 2)
}

async function handleArchiveAgent(argsRaw: string, actorId?: string): Promise<string> {
  const { agent_id, reason } = JSON.parse(argsRaw || '{}') as { agent_id?: string; reason?: string }
  if (!agent_id) return 'Error: agent_id is required'

  const existing = await prisma.agent.findUnique({
    where: { id: agent_id },
    select: { name: true, metadata: true },
  })
  if (!existing) return `Error: agent ${agent_id} not found`

  const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
  await prisma.agent.update({
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
  await auditLog(actorId, msg)
  return `Archived agent "${existing.name}" (${agent_id})`
}

async function handleEscalateTask(argsRaw: string, actorId?: string): Promise<string> {
  const { task_id, user_id } = JSON.parse(argsRaw || '{}') as { task_id?: string; user_id?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!user_id) return 'Error: user_id is required'

  await prisma.task.update({
    where: { id: task_id },
    data:  { assignedUserId: user_id, status: 'pending' },
  })
  const [task, user] = await Promise.all([
    prisma.task.findUnique({ where: { id: task_id }, select: { title: true } }),
    prisma.user.findUnique({ where: { id: user_id }, select: { name: true, username: true } }),
  ])
  const who = user?.name ?? user?.username ?? user_id
  const msg = `👤 Escalated **${task?.title}** → **${who}**`
  await auditLog(actorId, msg)
  return `Escalated task "${task?.title}" to user "${who}"`
}

async function handleGetTaskEvents(argsRaw: string): Promise<string> {
  const { task_id, limit } = JSON.parse(argsRaw || '{}') as { task_id?: string; limit?: number }
  if (!task_id) return 'Error: task_id is required'

  const [task, events] = await Promise.all([
    prisma.task.findUnique({
      where: { id: task_id },
      select: { title: true, status: true, assignedAgent: true, description: true },
    }),
    prisma.taskEvent.findMany({
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

async function handleCloseTask(argsRaw: string, actorId?: string): Promise<string> {
  const { task_id, summary } = JSON.parse(argsRaw || '{}') as { task_id?: string; summary?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!summary?.trim()) return 'Error: summary is required'

  const task = await prisma.task.findUnique({ where: { id: task_id }, select: { title: true, status: true } })
  if (!task) return `Error: task ${task_id} not found`
  if (task.status !== 'pending_validation') {
    return `Error: task is "${task.status}" — orion_close_task only operates on pending_validation tasks`
  }

  await prisma.task.update({ where: { id: task_id }, data: { status: 'done' } })
  const msg = `✅ Validated & closed **${task.title}** — ${summary}`
  await auditLog(actorId, msg)
  return `Closed task "${task.title}"`
}

async function handleReopenTask(argsRaw: string, actorId?: string): Promise<string> {
  const { task_id, reason } = JSON.parse(argsRaw || '{}') as { task_id?: string; reason?: string }
  if (!task_id) return 'Error: task_id is required'

  await prisma.task.update({
    where: { id: task_id },
    data:  { status: 'pending', assignedAgent: null },
  })
  const task = await prisma.task.findUnique({ where: { id: task_id }, select: { title: true } })
  const msg = `🔄 Reopened **${task?.title}** — ${reason ?? 'validation failed'}`
  await auditLog(actorId, msg)
  return `Reopened task "${task?.title}" — ${reason ?? 'validation failed'}`
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Execute a management tool by name.
 *
 * @param name     - Tool name (must match a MANAGEMENT_TOOL_DEFS entry)
 * @param argsRaw  - JSON-encoded arguments string
 * @param actorId  - Optional agent ID for SOC2 audit attribution
 */
export async function executeManagedTool(name: string, argsRaw: string, actorId?: string): Promise<string> {
  try {
    switch (name) {
      case 'orion_list_agents':   return await handleListAgents(argsRaw)
      case 'orion_list_tasks':    return await handleListTasks(argsRaw)
      case 'orion_assign_task':   return await handleAssignTask(argsRaw, actorId)
      case 'orion_create_agent':  return await handleCreateAgent(argsRaw, actorId)
      case 'orion_archive_agent': return await handleArchiveAgent(argsRaw, actorId)
      case 'orion_escalate_task':   return await handleEscalateTask(argsRaw, actorId)
      case 'orion_get_task_events': return await handleGetTaskEvents(argsRaw)
      case 'orion_close_task':      return await handleCloseTask(argsRaw, actorId)
      case 'orion_reopen_task':     return await handleReopenTask(argsRaw, actorId)
      default:
        return `Error: unknown management tool "${name}"`
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}
