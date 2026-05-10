/**
 * ORION tool definitions and execution for room agents.
 *
 * Tools are passed as OpenAI function-call schemas to the LLM.
 * When the model calls a tool, executeTool() runs the corresponding
 * Prisma operation and returns a result string the model can act on.
 *
 * Available tools:
 *   create_task         — create a new task
 *   update_task         — update status/title/description of an existing task
 *   create_agent        — create a new agent and invite it to the current room
 *   orion_get_tasks     — list tasks (server-side Prisma, no HTTP round-trip)
 *   orion_get_agents    — list agents (server-side Prisma, no HTTP round-trip)
 *   orion_manage_task   — assign, update status, or post feed message for a task
 */

import { prisma } from './db'
import { writeVaultSecret } from './vault'
import { getOrFetch } from './system-cache'

// ── Tool definitions (OpenAI function-call format) ────────────────────────────

export const ORION_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Create a new task in ORION. Use this when a user asks you to log, track, or create a task.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short task title' },
          description: { type: 'string', description: 'Detailed description of what needs to be done' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority (default: medium)' },
          status:      { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Initial status (default: pending)' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update an existing task. Use this to change status, title, or description.',
      parameters: {
        type: 'object',
        properties: {
          taskId:      { type: 'string', description: 'The ID of the task to update' },
          title:       { type: 'string', description: 'New title (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          status:      { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status (optional)' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority (optional)' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_agent',
      description: 'Create a new AI agent and automatically invite it to the current chat room. Use this when asked to spin up, create, or add a new agent.',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Unique name for the agent' },
          role:        { type: 'string', description: 'Role or job title (e.g. "Creative Writer", "QA Engineer")' },
          systemPrompt:{ type: 'string', description: 'Full system prompt defining the agent\'s personality and behavior' },
          llm:         { type: 'string', description: 'LLM identifier to use. Leave blank to use the same model as you.' },
        },
        required: ['name', 'systemPrompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'orion_get_tasks',
      description: 'List tasks in ORION. Filter by status or assigned agent.',
      parameters: {
        type: 'object',
        properties: {
          status:        { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Filter by status (optional)' },
          assignedAgent: { type: 'string', description: 'Filter by assigned agent ID (optional)' },
          limit:         { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'orion_get_agents',
      description: 'List all agents in ORION with their status, role, and metadata.',
      parameters: {
        type: 'object',
        properties: {
          include_archived: { type: 'boolean', description: 'Include archived agents (default false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'orion_manage_task',
      description: 'Assign a task to an agent, update its status, or append a feed note.',
      parameters: {
        type: 'object',
        properties: {
          taskId:        { type: 'string', description: 'Task ID to act on' },
          assignedAgent: { type: 'string', description: 'Agent ID to assign the task to (optional)' },
          status:        { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status (optional)' },
          note:          { type: 'string', description: 'Feed note to append to the task (optional)' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_secret',
      description: 'Create a skeleton External Secret in ORION backed by Vault. Writes PLACEHOLDER values to Vault so the human can fill in the real values inside ORION (Infrastructure > External Secrets > pencil icon). Use this when asked to scaffold, create, or set up a secret for a deployment.',
      parameters: {
        type: 'object',
        properties: {
          environmentName:  { type: 'string', description: 'Name of the ORION environment to create the secret in.' },
          name:             { type: 'string', description: 'Human-readable label for the ExternalSecret (e.g. "gitea-db-secret")' },
          vaultPath:        { type: 'string', description: 'Vault KV v2 path relative to the "secret" mount (e.g. "gitea/db"). No "secret/data/" prefix.' },
          keyNames:         { type: 'array', items: { type: 'string' }, description: 'List of secret key names to scaffold (e.g. ["DB_PASSWORD", "DB_USER"]). PLACEHOLDER values will be written to Vault.' },
          namespace:        { type: 'string', description: 'Kubernetes namespace where the Secret will live (default: "default")' },
          description:      { type: 'string', description: 'What this secret is for and who uses it (optional)' },
          targetSecretName: { type: 'string', description: 'K8s Secret name (defaults to the ExternalSecret name)' },
          refreshInterval:  { type: 'string', description: 'ESO sync interval, e.g. "1h", "15m" (default: "1h")' },
        },
        required: ['environmentName', 'name', 'vaultPath', 'keyNames'],
      },
    },
  },
] as const

/**
 * Returns a copy of ORION_TOOL_DEFINITIONS with the write_secret
 * environmentName description patched to list actual environment names
 * from the DB — so the LLM never needs to call a tool to discover them.
 */
export async function buildToolDefinitions() {
  return getOrFetch('environments', 'cache.environments.ttl', async () => {
    const envs = await prisma.environment.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
    const envNames = envs.map((e: { name: string }) => `"${e.name}"`).join(', ') || 'none configured'
    return _buildToolDefinitionsWithEnvs(envNames)
  })
}

function _buildToolDefinitionsWithEnvs(envNames: string) {
  return ORION_TOOL_DEFINITIONS.map(def => {
    if (def.function.name !== 'write_secret') return def
    return {
      ...def,
      function: {
        ...def.function,
        parameters: {
          ...def.function.parameters,
          properties: {
            ...def.function.parameters.properties,
            environmentName: {
              type: 'string' as const,
              description: `Name of the ORION environment to create the secret in. Available environments: ${envNames}.`,
            },
          },
        },
      },
    }
  })
}

// ── Tool execution ────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>

export async function executeTool(
  toolName: string,
  args: ToolArgs,
  context: { roomId: string; callerAgentId: string; callerLlm: string },
): Promise<string> {
  try {
    switch (toolName) {
      case 'create_task': {
        const task = await prisma.task.create({
          data: {
            title:       String(args.title ?? 'Untitled Task'),
            description: args.description ? String(args.description) : undefined,
            priority:    String(args.priority ?? 'medium'),
            status:      String(args.status ?? 'pending'),
            createdBy:   context.callerAgentId,
            assignedAgent: context.callerAgentId,
          },
        })
        return `Task created: "${task.title}" (id: ${task.id}, status: ${task.status}, priority: ${task.priority})`
      }

      case 'update_task': {
        const taskId = String(args.taskId ?? '')
        if (!taskId) return 'Error: taskId is required'
        const existing = await prisma.task.findUnique({ where: { id: taskId } })
        if (!existing) return `Error: task ${taskId} not found`
        const updated = await prisma.task.update({
          where: { id: taskId },
          data: {
            title:       args.title       ? String(args.title)       : undefined,
            description: args.description ? String(args.description) : undefined,
            status:      args.status      ? String(args.status)      : undefined,
            priority:    args.priority    ? String(args.priority)    : undefined,
          },
        })
        return `Task updated: "${updated.title}" (id: ${updated.id}, status: ${updated.status})`
      }

      case 'create_agent': {
        const name = String(args.name ?? '').trim()
        if (!name) return 'Error: name is required'

        // Check for name collision
        const existing = await prisma.agent.findUnique({ where: { name } })
        if (existing) return `Error: an agent named "${name}" already exists (id: ${existing.id})`

        const llm = args.llm ? String(args.llm) : context.callerLlm

        const agent = await prisma.agent.create({
          data: {
            name,
            role:   args.role ? String(args.role) : undefined,
            type:   'custom',
            status: 'online',
            metadata: {
              systemPrompt: String(args.systemPrompt ?? ''),
              contextConfig: { llm },
            } as any,
          },
        })

        // Auto-invite to the current room
        await prisma.chatRoomMember.create({
          data: { roomId: context.roomId, agentId: agent.id, role: 'member' },
        })

        // Post a system message so participants see it arrive
        await prisma.chatMessage.create({
          data: {
            roomId: context.roomId,
            senderType: 'system',
            content: `${agent.name} has joined the room.`,
          },
        })

        return `Agent created and invited: "${agent.name}" (id: ${agent.id}, llm: ${llm})`
      }

      case 'orion_get_tasks': {
        const where: Record<string, unknown> = {}
        if (args.status)        where.status        = String(args.status)
        if (args.assignedAgent) where.assignedAgent = String(args.assignedAgent)
        const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 20
        const tasks = await prisma.task.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: limit,
          include: { agent: { select: { name: true } } },
        })
        if (tasks.length === 0) return 'No tasks found.'
        return tasks.map((t: any) =>
          `[${t.id}] ${t.title} — status: ${t.status}, priority: ${t.priority}, assigned: ${t.agent?.name ?? 'unassigned'}`
        ).join('\n')
      }

      case 'orion_get_agents': {
        const includeArchived = args.include_archived === true
        const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
        const filtered = includeArchived
          ? agents
          : agents.filter((a: any) => (a.metadata as Record<string, unknown> | null)?.archived !== true)
        return filtered.map((a: any) =>
          `[${a.id}] ${a.name} — ${a.role ?? 'no role'}, status: ${a.status}`
        ).join('\n')
      }

      case 'orion_manage_task': {
        const taskId = String(args.taskId ?? '')
        if (!taskId) return 'Error: taskId is required'
        const existing = await prisma.task.findUnique({ where: { id: taskId } })
        if (!existing) return `Error: task ${taskId} not found`
        const data: Record<string, unknown> = {}
        if (args.assignedAgent) data.assignedAgent = String(args.assignedAgent)
        if (args.status)        data.status        = String(args.status)
        const updated = Object.keys(data).length > 0
          ? await prisma.task.update({ where: { id: taskId }, data })
          : existing
        if (args.note) {
          await prisma.taskEvent.create({
            data: { taskId, eventType: 'note', content: String(args.note) },
          })
        }
        return `Task "${updated.title}" (${taskId}): status=${updated.status}, assigned=${updated.assignedAgent ?? 'unassigned'}${args.note ? ', note appended' : ''}`
      }

      case 'write_secret': {
        const environmentName = String(args.environmentName ?? '').trim()
        const name            = String(args.name ?? '').trim()
        const vaultPath       = String(args.vaultPath ?? '').trim()
        const keyNames        = Array.isArray(args.keyNames) ? (args.keyNames as unknown[]).map(String).filter(Boolean) : []

        if (!environmentName) return 'Error: environmentName is required'
        if (!name)            return 'Error: name is required'
        if (!vaultPath)       return 'Error: vaultPath is required'
        if (keyNames.length === 0) return 'Error: keyNames must contain at least one key'

        // Resolve environment by name
        const env = await prisma.environment.findUnique({ where: { name: environmentName } })
        if (!env) {
          const all = await prisma.environment.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
          const names = all.map((e: { name: string }) => `"${e.name}"`).join(', ')
          return `Error: environment "${environmentName}" not found. Available environments: ${names || 'none'}.`
        }

        const namespace       = String(args.namespace       ?? 'default').trim() || 'default'
        const description     = args.description     ? String(args.description).trim()     : null
        const targetSecretName = args.targetSecretName ? String(args.targetSecretName).trim() || null : null
        const refreshInterval  = String(args.refreshInterval ?? '1h').trim() || '1h'

        // Write PLACEHOLDER values to Vault for each key
        const placeholderData: Record<string, string> = {}
        for (const key of keyNames) placeholderData[key] = 'PLACEHOLDER'

        try {
          await writeVaultSecret(vaultPath, placeholderData)
        } catch (e) {
          return `Error: failed to write placeholder to Vault: ${e instanceof Error ? e.message : String(e)}`
        }

        // Persist metadata (status=draft — human must fill real values in ORION)
        const dataKeys = keyNames.map(k => ({ remoteKey: k, secretKey: k }))
        const secret = await prisma.managedSecret.create({
          data: {
            environmentId:    env.id,
            createdBy:        null,  // callerAgentId is an Agent ID, not a User ID
            name,
            namespace,
            description,
            secretStore:      'vault-backend',
            secretStoreKind:  'ClusterSecretStore',
            remoteRef:        vaultPath,
            targetSecretName,
            refreshInterval,
            dataKeys,
            tags:             [],
            status:           'draft',
          },
        })

        return [
          `Secret shell created (id: ${secret.id}):`,
          `  Name:      ${secret.name}`,
          `  Vault path: secret/data/${vaultPath}`,
          `  Keys:      ${keyNames.join(', ')}`,
          `  Namespace: ${namespace}`,
          `  Status:    draft (PLACEHOLDER values written — real values needed)`,
          ``,
          `Next step: open Infrastructure > External Secrets in environment "${environmentName}", find "${name}", and click the pencil icon to enter the real values. ORION will write them to Vault and mark the secret as applied.`,
        ].join('\n')
      }

      default:
        return `Error: unknown tool "${toolName}"`
    }
  } catch (e) {
    return `Error executing ${toolName}: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── System prompt addendum ────────────────────────────────────────────────────

export const TOOLS_SYSTEM_ADDENDUM = `

## Your ORION Tools

You have access to these tools. Use them — do not pretend to perform an action when you can call a tool instead.

**Read ORION state:**
- **orion_get_tasks**: List tasks, optionally filtered by status or assigned agent.
- **orion_get_agents**: List all active agents and their roles.

**Write ORION state:**
- **create_task**: Log a new task on the board (title, description, priority, status).
- **update_task**: Update an existing task by ID (status, title, description, priority).
- **orion_manage_task**: Assign a task to an agent, change status, or append a feed note.
- **create_agent**: Create a new AI agent and invite it to this chat room.
- **write_secret**: Scaffold an External Secret in ORION backed by Vault — writes PLACEHOLDER values so the human can fill in real values via the ORION UI.

When you use a tool, report the result back clearly (e.g. "Done — PR #42 opened: 'feat: deploy Tailscale Operator'").`
