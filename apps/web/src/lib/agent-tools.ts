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
 *   write_secret        — scaffold a new Vault-backed ExternalSecret
 *   update_secret       — patch namespace/description/keys on an existing secret
 *   delete_secret       — remove an ORION secret record (not the Vault secret)
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
  {
    type: 'function' as const,
    function: {
      name: 'update_secret',
      description: 'Update metadata on an existing ORION-managed secret — namespace, description, key names, or Vault path. Use this to correct a secret that was created with the wrong namespace or other wrong values. Get the secret id from orion_list_secrets.',
      parameters: {
        type: 'object',
        properties: {
          secretId:         { type: 'string', description: 'The ORION secret id (from orion_list_secrets)' },
          namespace:        { type: 'string', description: 'New Kubernetes namespace' },
          description:      { type: 'string', description: 'New description' },
          vaultPath:        { type: 'string', description: 'New Vault KV v2 path (no "secret/data/" prefix)' },
          keyNames:         { type: 'array', items: { type: 'string' }, description: 'Replace the list of secret key names' },
          targetSecretName: { type: 'string', description: 'New K8s Secret name' },
          refreshInterval:  { type: 'string', description: 'New ESO sync interval (e.g. "1h")' },
        },
        required: ['secretId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_secret',
      description: 'Delete an ORION-managed secret record. Only deletes the ORION metadata — does NOT delete the Vault secret or the K8s Secret. Use when a secret was created with wrong parameters and needs to be recreated, or when it is genuinely no longer needed. Get the secret id from orion_list_secrets.',
      parameters: {
        type: 'object',
        properties: {
          secretId: { type: 'string', description: 'The ORION secret id (from orion_list_secrets)' },
          reason:   { type: 'string', description: 'Why this secret is being deleted (for the audit log)' },
        },
        required: ['secretId'],
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

        // Enforce vault path convention: must be under the environment's vaultPathPrefix
        const envMeta = env as Record<string, unknown>
        const prefix = envMeta.vaultPathPrefix as string | undefined
        const normalizedPath = vaultPath.replace(/^secret\/data\//, '')
        if (prefix) {
          const normalizedPrefix = prefix.replace(/\/$/, '')
          if (!normalizedPath.startsWith(normalizedPrefix + '/') && normalizedPath !== normalizedPrefix) {
            return `Error: vaultPath "${vaultPath}" is outside this environment's allowed prefix "${normalizedPrefix}/". Use a path like "${normalizedPrefix}/<service-name>".`
          }
        }

        // Idempotency guard: refuse to overwrite an already-applied secret
        const existing = await prisma.managedSecret.findFirst({
          where: { environmentId: env.id, name },
          orderBy: { createdAt: 'desc' },
        })
        if (existing) {
          if (existing.status === 'applied') {
            return [
              `Secret "${name}" already exists and is applied (id: ${existing.id}).`,
              `  Vault path: secret/data/${existing.remoteRef}`,
              `  Keys:       ${(existing.dataKeys as Array<{ secretKey: string }>).map(k => k.secretKey).join(', ')}`,
              `  Applied at: ${existing.appliedAt?.toISOString() ?? 'unknown'}`,
              ``,
              `DO NOT call write_secret again — real values are already in Vault and calling this tool will overwrite them with PLACEHOLDER.`,
              `If the ExternalSecret is failing, diagnose with kubectl_get or kubectl_logs. Do not recreate the secret.`,
            ].join('\n')
          }
          // Draft already exists — return it rather than creating a duplicate
          return [
            `Secret "${name}" already exists in draft state (id: ${existing.id}) — not creating a duplicate.`,
            `  Vault path: secret/data/${existing.remoteRef}`,
            `  Status:    draft (waiting for real values)`,
            ``,
            `Next step: open Infrastructure > External Secrets in environment "${environmentName}", find "${name}", and click the pencil icon to enter the real values.`,
          ].join('\n')
        }

        const namespace        = String(args.namespace        ?? 'default').trim() || 'default'
        const description      = args.description      ? String(args.description).trim()      : null
        const targetSecretName = args.targetSecretName ? String(args.targetSecretName).trim() || null : null
        const refreshInterval  = String(args.refreshInterval  ?? '1h').trim() || '1h'

        // Write PLACEHOLDER values to Vault for each key
        const placeholderData: Record<string, string> = {}
        for (const key of keyNames) placeholderData[key] = 'PLACEHOLDER'

        try {
          await writeVaultSecret(normalizedPath, placeholderData)
        } catch (e) {
          return `Error: failed to write placeholder to Vault: ${e instanceof Error ? e.message : String(e)}`
        }

        // Persist metadata (status=draft — human must fill real values in ORION)
        const dataKeys = keyNames.map(k => ({ remoteKey: k, secretKey: k }))
        const secret = await prisma.managedSecret.create({
          data: {
            environmentId:    env.id,
            createdBy:        null,
            name,
            namespace,
            description,
            secretStore:      'vault-backend',
            secretStoreKind:  'ClusterSecretStore',
            remoteRef:        normalizedPath,
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
          `  Vault path: secret/data/${normalizedPath}`,
          `  Keys:      ${keyNames.join(', ')}`,
          `  Namespace: ${namespace}`,
          `  Status:    draft (PLACEHOLDER values written — real values needed)`,
          ``,
          `Next step: open Infrastructure > External Secrets in environment "${environmentName}", find "${name}", and click the pencil icon to enter the real values. ORION will write them to Vault and mark the secret as applied.`,
          ``,
          `IMPORTANT: Do NOT call write_secret again for this secret — once the user enters real values the status becomes "applied" and further calls are blocked to protect the credentials.`,
        ].join('\n')
      }

      case 'update_secret': {
        const secretId = String(args.secretId ?? '').trim()
        if (!secretId) return 'Error: secretId is required'

        const existing = await prisma.managedSecret.findUnique({ where: { id: secretId } })
        if (!existing) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`

        const data: Record<string, unknown> = {}
        if (args.namespace        != null) data.namespace        = String(args.namespace).trim()
        if (args.description      != null) data.description      = String(args.description).trim() || null
        if (args.vaultPath        != null) data.remoteRef        = String(args.vaultPath).trim()
        if (args.targetSecretName != null) data.targetSecretName = String(args.targetSecretName).trim() || null
        if (args.refreshInterval  != null) data.refreshInterval  = String(args.refreshInterval).trim() || '1h'
        if (Array.isArray(args.keyNames)) {
          const keys = (args.keyNames as unknown[]).map(String).filter(Boolean)
          if (keys.length > 0) data.dataKeys = keys.map(k => ({ remoteKey: k, secretKey: k }))
        }

        if (Object.keys(data).length === 0) return 'Error: no fields to update — provide at least one of: namespace, description, vaultPath, keyNames, targetSecretName, refreshInterval'

        const updated = await prisma.managedSecret.update({ where: { id: secretId }, data })
        return [
          `Secret "${updated.name}" (${secretId}) updated:`,
          ...Object.keys(data).map(k => `  ${k}: ${JSON.stringify((updated as any)[k])}`),
        ].join('\n')
      }

      case 'delete_secret': {
        const secretId = String(args.secretId ?? '').trim()
        if (!secretId) return 'Error: secretId is required'

        const existing = await prisma.managedSecret.findUnique({ where: { id: secretId } })
        if (!existing) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`

        await prisma.managedSecret.delete({ where: { id: secretId } })
        const reason = args.reason ? ` Reason: ${String(args.reason)}` : ''
        return `Deleted ORION secret record "${existing.name}" (${secretId}) from namespace "${existing.namespace}".${reason}\nNote: Vault secret and K8s Secret (if applied) were NOT deleted — only the ORION metadata record.`
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

You have access to ORION management tools. Use them — do not pretend to perform an action when you can call a tool instead. Do NOT call tools in response to conversational messages, greetings, or check-ins — just reply directly.

**MANDATORY — Tool Discovery:**
If you do not know a tool's exact name with certainty, you MUST call **list_tools** before calling anything else. Never guess or recall tool names from memory — tool names change and your memory will be wrong.

Workflow:
1. Not sure of the tool name? → call **list_tools(category)** first (categories: tasks, agents, rooms, features, gitops, knowledge, environment, secrets, tools)
2. Know the name but unsure of params? → call **describe_tool(name)** before calling it
3. Tool doesn't exist or doesn't support what you need? → call **propose_tool** immediately (see Tool Gap Rule below)

**MANDATORY — Tool Gap Rule:**
If you cannot complete a task because a tool does not exist or does not support the required operation (e.g. file deletion, renaming, bulk operations):
1. Call **propose_tool** immediately to request the capability.
2. Tell the user you have requested it and what it would do.
Do NOT instruct the user to perform the action manually in a UI. Do NOT attempt workarounds with incorrect tool usage (e.g. empty file content to simulate deletion). Do NOT give up and explain why you cannot do it. Always propose_tool first.

**MANDATORY — Before any GitOps or infrastructure work:**
1. Call **orion_get_environment** to get the target environment's git repo, deployment path, and Vault prefix. Never assume where manifests go — always query.
2. Call **gitops_ls** to check what already exists in the repo. Never write a manifest for a resource that is already there — duplicate manifests break ArgoCD sync.
3. Then call **gitops_propose** with only the files that are missing or need changing.

**MANDATORY — After every merged PR:**
Do not declare success after opening or merging a PR. You must verify the deployment actually worked:
1. Wait 2-3 minutes for ArgoCD to sync, then call **kubectl_get** (resource: "pods", namespace: target) to check pod status.
2. If the pod is not Running, call **kubectl_logs** to read the error and diagnose before doing anything else.
3. Only declare success when the pod is Running and logs show no fatal errors.
4. Do NOT open another PR to fix a problem until you have read the logs and understand the root cause.

**MANDATORY — Secrets:**
1. Call **orion_list_secrets** before calling **write_secret** — if a secret with that name already exists in any state, do not call write_secret again.
2. After write_secret, tell the user exactly which secret to fill in and wait for confirmation before proceeding with the deployment.
3. Never assume a secret is filled in — check its status with **orion_list_secrets** before mounting it.

When you use a tool, report the result back clearly (e.g. "Done — PR #42 opened: 'feat: deploy Tailscale Operator'").`
