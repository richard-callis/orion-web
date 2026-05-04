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
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import tls from 'tls'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

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
        status:          { type: 'string',  description: 'Filter by status: pending, running, pending_validation, done, failed. Defaults to pending+running+failed. Use "pending_validation" to find tasks awaiting Veritas review.' },
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
  },
  {
    name: 'orion_update_agent',
    description: 'Update an existing agent\'s role, description, system prompt, or LLM. Use this to improve agents based on observed performance — sharpen their prompts, fix their role description, or reassign their LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id:     { type: 'string', description: 'Agent ID to update' },
        role:         { type: 'string', description: 'Updated one-line role description' },
        description:  { type: 'string', description: 'Updated longer description' },
        systemPrompt: { type: 'string', description: 'Updated full system prompt' },
        llm:          { type: 'string', description: 'Updated LLM (e.g. ext:<id>)' },
      },
      required: ['agent_id'],
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
  {
    name: 'orion_list_rooms',
    description: 'List chat rooms. Optionally filter by feature_id to find the coordination room for a feature.',
    inputSchema: {
      type: 'object',
      properties: {
        feature_id: { type: 'string', description: 'Filter by feature ID to find the feature coordination room' },
      },
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    name: 'orion_cluster_health',
    description: 'Comprehensive health check across all ORION-managed systems: (1) all enabled IngressRoutes — HTTP reachability and SSL cert validity; (2) Kubernetes cluster node readiness and pod issues (CrashLoopBackOff, OOMKilled, Failed, Pending); (3) all registered environment gateways; (4) ORION system services (Gitea, Vault, ORION itself). Each degraded item includes a canonical taskKey field — pass this as dedup_key when calling orion_create_task to prevent duplicate fix tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Limit check to a specific namespace (optional — omit to check all namespaces)' },
      },
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

// ── Shared arg parser ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(argsRaw: string): any {
  try { return JSON.parse(argsRaw || '{}') } catch { return {} }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListAgents(argsRaw: string): Promise<string> {
  const { include_archived } = parseArgs(argsRaw) as { include_archived?: boolean }
  const agents = await prisma.agent.findMany({
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
        status:      a.status,   // 'online' | 'offline' — only assign tasks to online agents
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
  const { status, unassigned_only } = parseArgs(argsRaw) as {
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
  const { task_id, agent_id } = parseArgs(argsRaw) as { task_id?: string; agent_id?: string }
  if (!task_id) return 'Error: task_id is required'
  if (!agent_id) return 'Error: agent_id is required'

  const targetAgent = await prisma.agent.findUnique({ where: { id: agent_id }, select: { name: true, status: true, metadata: true } })
  if (!targetAgent) return `Error: agent "${agent_id}" not found`
  const targetMeta = (targetAgent.metadata ?? {}) as Record<string, unknown>
  if (targetMeta.archived === true) {
    return `Error: agent "${targetAgent.name}" is archived and cannot be assigned tasks. Use orion_list_agents to find an active agent.`
  }
  if (targetAgent.status === 'offline') {
    return `Error: agent "${targetAgent.name}" is offline and cannot accept tasks right now. Use orion_list_agents to find an online agent.`
  }

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
  const spec = parseArgs(argsRaw) as {
    name?: string
    role?: string
    systemPrompt?: string
    type?: string
    description?: string
    persistent?: boolean
    llm?: string
    // legacy support — metadata.systemPrompt and metadata.contextConfig still accepted
    metadata?: Record<string, unknown>
  }

  if (!spec.name?.trim())         return 'Error: name is required'
  if (!spec.role?.trim())         return 'Error: role is required'
  if (!spec.systemPrompt?.trim()) return 'Error: systemPrompt is required — agents without a system prompt will not behave correctly'
  if (spec.systemPrompt.trim().length < 20) return 'Error: systemPrompt is too short (minimum 20 characters) — provide a meaningful role description'

  // SOC2 [INPUT-001]: reserved name guard
  if (RESERVED_AGENT_NAMES.includes(spec.name.toLowerCase())) {
    await auditLog(actorId, `⚠️ Cannot create agent: **${spec.name}** is a reserved name`)
    return `Error: "${spec.name}" is a reserved agent name`
  }

  // Idempotency guard — return existing agent rather than creating a duplicate.
  // Prevents Alpha's watcher from stacking Debugger agents on each cycle.
  const existingByName = await prisma.agent.findUnique({
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

  // Resolve default LLM — top-level llm field takes precedence, then metadata.contextConfig.llm, then system default
  const defaultLlm     = await getDefaultModelId()
  const legacyMeta     = (spec.metadata ?? {}) as Record<string, unknown>
  const legacyCfg      = (legacyMeta.contextConfig ?? {}) as Record<string, unknown>
  const resolvedLlm    = spec.llm ?? (legacyCfg.llm as string | undefined) ?? defaultLlm
  // Top-level systemPrompt takes precedence over legacy metadata.systemPrompt
  const resolvedPrompt = spec.systemPrompt ?? (legacyMeta.systemPrompt as string | undefined) ?? ''
  const contextConfig  = { ...legacyCfg, llm: resolvedLlm, persistent: spec.persistent ?? legacyCfg.persistent ?? false }
  const metadata       = { ...legacyMeta, systemPrompt: resolvedPrompt, contextConfig }

  const created = await prisma.agent.create({
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

async function handleArchiveAgent(argsRaw: string, actorId?: string): Promise<string> {
  const { agent_id, reason } = parseArgs(argsRaw) as { agent_id?: string; reason?: string }
  if (!agent_id) return 'Error: agent_id is required'

  const existing = await prisma.agent.findUnique({
    where: { id: agent_id },
    select: { name: true, metadata: true },
  })
  if (!existing) return `Error: agent ${agent_id} not found`

  const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
  const contextConfig = (existingMeta.contextConfig ?? {}) as Record<string, unknown>
  if (contextConfig.persistent === true) {
    return `Error: agent "${existing.name}" is a persistent system agent and cannot be archived.`
  }
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
  const { task_id, user_id } = parseArgs(argsRaw) as { task_id?: string; user_id?: string }
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
  const { task_id, limit } = parseArgs(argsRaw) as { task_id?: string; limit?: number }
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
  const { task_id, summary } = parseArgs(argsRaw) as { task_id?: string; summary?: string }
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
  const { task_id, reason } = parseArgs(argsRaw) as { task_id?: string; reason?: string }
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

async function handleListRooms(argsRaw: string): Promise<string> {
  const { feature_id } = parseArgs(argsRaw) as { feature_id?: string }

  const where: Record<string, unknown> = {}
  if (feature_id) where.featureId = feature_id

  const rooms = await prisma.chatRoom.findMany({
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

async function handleCreateFeature(argsRaw: string, actorId?: string): Promise<string> {
  const { epicId, title, description } = parseArgs(argsRaw) as {
    epicId?: string
    title?: string
    description?: string
  }
  if (!epicId) return 'Error: epicId is required'
  if (!title?.trim()) return 'Error: title is required'

  const epic = await prisma.epic.findUnique({ where: { id: epicId } })
  if (!epic) return `Error: epic ${epicId} not found`
  if (!epic.plan) {
    return 'Error: Epic must have a saved plan before features can be created. Use the Save as Plan button or ask the user to save the plan first.'
  }

  const feature = await prisma.feature.create({
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

async function handleCreateTask(argsRaw: string, actorId?: string): Promise<string> {
  const { featureId, title, description, plan, targetEnvironment, dedup_key } = parseArgs(argsRaw) as {
    featureId?: string
    title?: string
    description?: string
    plan?: string
    dedup_key?: string  // if set, creation is skipped when an open task with this key already exists
    targetEnvironment?: { namespace?: string; hostname?: string; storageClass?: string; vaultPath?: string }
  }
  if (!featureId) return 'Error: featureId is required'
  if (!title?.trim()) return 'Error: title is required'
  if (!plan?.trim()) return 'Error: plan is required'

  const feature = await prisma.feature.findUnique({ where: { id: featureId } })
  if (!feature) return `Error: feature ${featureId} not found`
  if (!feature.plan) {
    return 'Error: Feature must have a saved plan before tasks can be created.'
  }

  // Deduplication — if a dedup_key is provided, check for any open task with that key
  if (dedup_key?.trim()) {
    const existing = await prisma.task.findFirst({
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

  const task = await prisma.task.create({
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

async function handleSendMessage(argsRaw: string, actorId?: string): Promise<string> {
  const { room_id, content } = parseArgs(argsRaw) as { room_id?: string; content?: string }
  if (!room_id)  return 'Error: room_id is required'
  if (!content?.trim()) return 'Error: content is required'
  if (!actorId) return 'Error: actorId is required to send messages (SOC2 attribution)'

  const room = await prisma.chatRoom.findUnique({ where: { id: room_id }, select: { name: true } })
  if (!room) return `Error: room ${room_id} not found`

  // Hard rule: agents can only post to rooms they are members of
  const membership = await prisma.chatRoomMember.findUnique({
    where: { roomId_agentId: { roomId: room_id, agentId: actorId } },
  })
  if (!membership) return `Error: you are not a member of room "${room.name}" — agents may only send messages to rooms they belong to`

  await prisma.chatMessage.create({
    data: {
      roomId:     room_id,
      agentId:    actorId,
      senderType: 'agent',
      content:    content.trim(),
    },
  })

  // SOC2: audit log the send action
  await auditLog(actorId, `💬 Sent message to room **${room.name}** (${room_id})`)

  return `Message posted to room "${room.name}" (${room_id})`
}

async function handleUpdateAgent(argsRaw: string, actorId?: string): Promise<string> {
  const spec = parseArgs(argsRaw) as {
    agent_id?: string
    role?: string
    description?: string
    systemPrompt?: string
    llm?: string
  }
  if (!spec.agent_id) return 'Error: agent_id is required'

  const existing = await prisma.agent.findUnique({
    where:  { id: spec.agent_id },
    select: { id: true, name: true, metadata: true },
  })
  if (!existing) return `Error: agent ${spec.agent_id} not found`

  const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
  const existingCfg  = (existingMeta.contextConfig ?? {}) as Record<string, unknown>

  const updatedMeta: Record<string, unknown> = { ...existingMeta }
  if (spec.systemPrompt !== undefined) updatedMeta.systemPrompt = spec.systemPrompt
  if (spec.llm !== undefined) updatedMeta.contextConfig = { ...existingCfg, llm: spec.llm }

  const data: Record<string, unknown> = { metadata: updatedMeta }
  if (spec.role        !== undefined) data.role        = spec.role
  if (spec.description !== undefined) data.description = spec.description

  await prisma.agent.update({ where: { id: spec.agent_id }, data })
  await auditLog(actorId, `✏️ Updated agent **${existing.name}** (${spec.agent_id})`)
  return `Updated agent "${existing.name}" (${spec.agent_id})`
}

// ── GitOps handler ────────────────────────────────────────────────────────────

async function handleProposeGitops(argsRaw: string, actorId?: string): Promise<string> {
  const { environment_id, title, reasoning, operation_description, changes } = parseArgs(argsRaw) as {
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
    const { prisma } = await import('./db')
    const { proposeChange } = await import('./gitops')

    const env = await prisma.environment.findFirst({
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

    await auditLog(actorId, `🔀 GitOps PR #${result.prNumber} ${action} — **${title}**`)
    return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
  } catch (e) {
    return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── Cluster health handler ────────────────────────────────────────────────────

interface IngressEntry { namespace: string; ingress: string; host: string }
interface HealthResult extends IngressEntry {
  status: 'healthy' | 'degraded'
  httpStatus: number
  sslValid: boolean
  sslDaysUntilExpiry: number
  issues: string[]
  taskKey: string  // canonical dedup key — use this as dedup_key when calling orion_create_task
}

function checkSSLCert(hostname: string): Promise<{ valid: boolean; daysUntilExpiry: number; error?: string }> {
  return new Promise((resolve) => {
    // Connect with default cert validation enabled. The secureConnect callback fires
    // only when the cert is valid — errors are handled separately below.
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
      // Map TLS error codes to human-readable messages
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
      // TLS/cert errors mean the service is running but has a bad cert — treat as
      // reachable so the SSL check (not this check) surfaces the cert issue.
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

async function handleClusterHealth(argsRaw: string): Promise<string> {
  const { namespace } = parseArgs(argsRaw) as { namespace?: string }

  const clusterIssues: HealthResult[] = []  // node/pod problems from K8s clusters
  const errors: string[] = []

  // ── Registered IngressRoutes — the source of truth for what ORION manages ─
  // These are the services explicitly registered in the Infrastructure → Ingress
  // tab. This is the canonical list, not a kubectl discovery sweep.
  const ingressRoutes = await prisma.ingressRoute.findMany({
    where:  { enabled: true },
    select: { host: true, tls: true, ingressPoint: { select: { name: true, domain: { select: { name: true } } } } },
  })

  // Deduplicate by host (same host may be on multiple routes/paths)
  const seenHosts = new Set<string>()
  const uniqueRoutes = ingressRoutes.filter((r) => {
    if (seenHosts.has(r.host)) return false
    seenHosts.add(r.host)
    return true
  })

  // ── Kubernetes environments — nodes and pods (kubectl) ────────────────────
  const envs = await prisma.environment.findMany({
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

  // Run HTTP + SSL checks on all registered IngressRoutes in parallel
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

  // Add cluster-level issues (NotReady nodes, CrashLoopBackOff pods, etc.)
  results.push(...clusterIssues)

  // ── All registered environment gateways ───────────────────────────────────
  // Every environment (cluster or otherwise) has a gatewayUrl — this is the
  // ORION gateway that connects ORION to the environment. Check it regardless
  // of type so we know whether ORION can reach each environment.
  const allEnvsWithGateway = await prisma.environment.findMany({
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
        sslValid:           true,   // internal gateway endpoint — no SSL check
        sslDaysUntilExpiry: 999,
        issues,
        taskKey:            `pulse:gateway:${env.name.toLowerCase().replace(/\s+/g, '-')}`,
      } as HealthResult)
    } catch (e) {
      errors.push(`${env.name} gateway: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── ORION system services ─────────────────────────────────────────────────
  // Core services bundled with ORION that are not registered environments but
  // must always be reachable. URLs are resolved from SystemSetting so an admin
  // can override them without a code deploy.
  const systemServiceSettings = await prisma.systemSetting.findMany({
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

// ── Tool request handler ──────────────────────────────────────────────────────

async function handleRequestTool(argsRaw: string, actorId?: string): Promise<string> {
  const { tool_description, tool_name } = parseArgs(argsRaw) as {
    tool_description?: string
    tool_name?: string
  }

  if (!tool_description) return 'Error: tool_description is required'

  const name = tool_name || tool_description.slice(0, 50)
  const msg = `🔧 Tool request **${name}** — ${tool_description.slice(0, 300)}`
  await auditLog(actorId, msg)

  return `Tool request submitted: "${name}"\n\nAlpha will review this request during the next watcher cycle. Description: ${tool_description}`
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

// ── Tool registry ─────────────────────────────────────────────────────────────

type Handler = (argsRaw: string, actorId?: string) => Promise<string>

const TOOL_REGISTRY: Record<string, Handler> = {
  orion_list_agents:    handleListAgents,
  orion_list_tasks:     handleListTasks,
  orion_assign_task:    handleAssignTask,
  orion_create_agent:   handleCreateAgent,
  orion_update_agent:   handleUpdateAgent,
  orion_archive_agent:  handleArchiveAgent,
  orion_escalate_task:  handleEscalateTask,
  orion_get_task_events: handleGetTaskEvents,
  orion_close_task:     handleCloseTask,
  orion_reopen_task:    handleReopenTask,
  orion_list_rooms:     handleListRooms,
  orion_send_message:   handleSendMessage,
  orion_create_feature: handleCreateFeature,
  orion_create_task:    handleCreateTask,
  orion_propose_gitops:    handleProposeGitops,
  orion_request_tool:      handleRequestTool,
  orion_cluster_health:    handleClusterHealth,
}

/**
 * Execute a management tool by name.
 *
 * @param name     - Tool name (must match a MANAGEMENT_TOOL_DEFS entry)
 * @param argsRaw  - JSON-encoded arguments string
 * @param actorId  - Optional agent ID for SOC2 audit attribution
 */
export async function executeManagedTool(name: string, argsRaw: string, actorId?: string): Promise<string> {
  try {
    const handler = TOOL_REGISTRY[name]
    if (!handler) return `Error: unknown management tool "${name}"`
    return await handler(argsRaw, actorId)
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}
