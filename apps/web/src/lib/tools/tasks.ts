/**
 * Task and feature planning tools: create, assign, escalate, inspect, close, reopen.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { auditLog, parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const ListTasksArgs = z.object({
  status: z.union([z.string(), z.array(z.string())]).nullish(),
  unassigned_only: z.boolean().nullish(),
  assigned_agent_id: z.string().nullish(),
  since: z.string().nullish(),
})

async function handleListTasks(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { status, unassigned_only, assigned_agent_id, since } = parseToolArgs(ListTasksArgs, args)
  const statuses = status
    ? (Array.isArray(status) ? status : [status])
    : ['pending', 'in_progress', 'failed']
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
    tasks.map((t) => ({
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

const AssignTaskArgs = z.object({
  task_id: z.string().nullish(),
  agent_id: z.string().nullish(),
})

async function handleAssignTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, agent_id } = parseToolArgs(AssignTaskArgs, args)
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

const EscalateTaskArgs = z.object({
  task_id: z.string().nullish(),
  user_id: z.string().nullish(),
})

async function handleEscalateTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, user_id } = parseToolArgs(EscalateTaskArgs, args)
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

const GetTaskEventsArgs = z.object({
  task_id: z.string().nullish(),
  limit: z.number().nullish(),
})

async function handleGetTaskEvents(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, limit } = parseToolArgs(GetTaskEventsArgs, args)
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
    events: events.map((e) => ({
      eventType: e.eventType,
      content:   e.content ? e.content.slice(0, 500) : null,
      agentId:   e.agentId,
      createdAt: e.createdAt,
    })),
    toolCallCount: events.filter((e) => e.eventType === 'tool_call').length,
  }, null, 2)
}

const CloseTaskArgs = z.object({
  task_id: z.string().nullish(),
  summary: z.string().nullish(),
})

async function handleCloseTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, summary } = parseToolArgs(CloseTaskArgs, args)
  if (!task_id) return 'Error: task_id is required'
  if (!summary?.trim()) return 'Error: summary is required'

  const task = await ctx.prisma.task.findUnique({ where: { id: task_id }, select: { title: true, status: true, featureId: true } })
  if (!task) return `Error: task ${task_id} not found`
  if (task.status !== 'pending_validation') {
    return `Error: task is "${task.status}" — orion_close_task only operates on pending_validation tasks`
  }

  await ctx.prisma.task.update({ where: { id: task_id }, data: { status: 'done' } })

  // Completion rollup — if this was the last task of the feature, mark the
  // feature (and possibly its epic) done and post summaries to their rooms.
  if (task.featureId) {
    const { checkFeatureCompletion } = await import('../task-completion')
    await checkFeatureCompletion(task.featureId, ctx.prisma as unknown as import('@prisma/client').PrismaClient).catch(e => console.error('[tool-registry] checkFeatureCompletion failed:', e instanceof Error ? e.message : e))
  }

  const msg = `✅ Validated & closed **${task.title}** — ${summary}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Closed task "${task.title}"`
}

const ReopenTaskArgs = z.object({
  task_id: z.string().nullish(),
  reason: z.string().nullish(),
})

async function handleReopenTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { task_id, reason } = parseToolArgs(ReopenTaskArgs, args)
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

const CreateFeatureArgs = z.object({
  epicId: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
})

async function handleCreateFeature(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { epicId, title, description } = parseToolArgs(CreateFeatureArgs, args)
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

const CreateTaskArgs = z.object({
  featureId: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  plan: z.string().nullish(),
  dedup_key: z.string().nullish(),
  depends_on: z.unknown(),
  priority: z.string().nullish(),
  targetEnvironment: z.object({ namespace: z.string().nullish(), hostname: z.string().nullish(), storageClass: z.string().nullish(), vaultPath: z.string().nullish(), certIssuer: z.string().nullish() }).passthrough().nullish(),
})

async function handleCreateTask(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { featureId, title, description, plan, targetEnvironment, dedup_key, depends_on, priority } = parseToolArgs(CreateTaskArgs, args)
  if (!featureId) return 'Error: featureId is required'
  if (!title?.trim()) return 'Error: title is required'
  if (!plan?.trim()) return 'Error: plan is required'

  // Normalize depends_on to a clean string[] of non-empty task IDs.
  const dependsOn: string[] = Array.isArray(depends_on)
    ? depends_on.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map(d => d.trim())
    : []

  const validPriorities = ['critical', 'high', 'medium', 'low']
  const taskPriority = priority && validPriorities.includes(priority) ? priority : 'medium'

  const feature = await ctx.prisma.feature.findUnique({ where: { id: featureId } })
  if (!feature) return `Error: feature ${featureId} not found`
  if (!feature.plan) {
    return 'Error: Feature must have a saved plan before tasks can be created.'
  }

  if (dedup_key?.trim()) {
    const existing = await ctx.prisma.task.findFirst({
      where: {
        featureId,
        status:   { in: ['pending', 'in_progress', 'pending_validation'] },
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
      priority:    taskPriority,
      dependsOn,
      createdBy:   actorId ?? 'agent',
      metadata:    {
        ...(targetEnvironment ? { targetEnvironment } : {}),
        ...(dedup_key?.trim() ? { dedup_key: dedup_key.trim() } : {}),
      } as object,
    },
  })
  await auditLog(actorId, `📋 Created task **${task.title}** (\`${task.id}\`) under feature \`${featureId}\`${targetEnvironment?.namespace ? ` → namespace: ${targetEnvironment.namespace}` : ''}`)
  return JSON.stringify({ id: task.id, title: task.title, featureId: task.featureId, plan: task.plan, dependsOn, priority: taskPriority, targetEnvironment: targetEnvironment ?? null }, null, 2)
}

export const orionListTasksTool: ToolDefinition = {
  name: 'orion_list_tasks',
  description: 'List tasks filtered by status, assignment, and date. Use this to find unassigned work, check what is running, or review failed tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      status:          { type: 'string',  description: 'Filter by status: pending, in_progress, pending_validation, done, failed. Defaults to pending+in_progress+failed. Use "pending_validation" to find tasks awaiting Veritas review.' },
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
}

export const orionAssignTaskTool: ToolDefinition = {
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
}

export const orionEscalateTaskTool: ToolDefinition = {
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
}

export const orionGetTaskEventsTool: ToolDefinition = {
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
}

export const orionCloseTaskTool: ToolDefinition = {
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
}

export const orionReopenTaskTool: ToolDefinition = {
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
}

export const orionCreateFeatureTool: ToolDefinition = {
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
}

export const orionCreateTaskTool: ToolDefinition = {
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
        description: 'For deployment tasks — the target environment as designated by the Atlas. Pass as an object with keys: namespace (e.g. "apps"), hostname (e.g. "myapp.example.com"), storageClass (e.g. "longhorn", if storage needed), vaultPath (e.g. "secret/data/myapp", if secrets needed), certIssuer (e.g. "letsencrypt-prod", if the Ingress is TLS-enabled — the executing agent must set this as the cert-manager.io/cluster-issuer annotation or no certificate will be issued).',
      },
      dedup_key: {
        type: 'string',
        description: 'Optional deduplication key. If an open task (pending/in_progress/pending_validation) with this exact key already exists under the same feature, creation is skipped and the existing task is returned. Use a stable identifier like "pulse:host:vault-proxy" or "pulse:node:talos-rpi2".',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of Task IDs that must reach status "done" before this task is allowed to run. Use the IDs returned by previous orion_create_task calls to express ordering (e.g. a deploy task that depends on a build task). Execution waves are computed from these dependencies at plan-approval time.',
      },
      priority: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
        description: 'Optional task priority. Defaults to "medium". Higher-priority tasks within the same execution wave run first.',
      },
    },
    required: ['featureId', 'title', 'plan'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'tasks',
  handler: handleCreateTask,
}
