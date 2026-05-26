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
  // ── SOC Case Management Tools ──────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'investigation_search',
      description: 'Search for investigations by status, severity, or name. Returns matching investigations with counts.',
      parameters: {
        type: 'object',
        properties: {
          status:  { type: 'string', enum: ['open', 'active', 'suspended', 'resolved', 'closed'], description: 'Filter by status' },
          search:  { type: 'string', description: 'Search in investigation names' },
          severity:{ type: 'number', description: 'Minimum severity (0-100)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_create',
      description: 'Create a new investigation case. Optionally link an incident. Auto-extracts observables from linked incident events.',
      parameters: {
        type: 'object',
        properties: {
          name:           { type: 'string', description: 'Investigation name' },
          severity:       { type: 'number', description: 'Severity 0-100' },
          tlp:            { type: 'string', enum: ['white', 'green', 'amber', 'red'], description: 'Traffic Light Protocol (default: amber)' },
          tags:           { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
          mitreAttackIds: { type: 'array', items: { type: 'string' }, description: 'MITRE ATT&CK technique IDs' },
          incidentId:     { type: 'string', description: 'Optional incident ID to link' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_read',
      description: 'Read full details of an investigation including incidents, notes, observables, and timeline.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
        },
        required: ['investigationId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_note',
      description: 'Add a note to an investigation. Warden notes are visually distinguished from human notes.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
          content:         { type: 'string', description: 'Note content in markdown' },
        },
        required: ['investigationId', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_update',
      description: 'Update investigation fields. Warden cannot transition to resolved/closed status.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
          status:          { type: 'string', enum: ['open', 'active', 'suspended'], description: 'New status (Warden: cannot set resolved/closed)' },
          severity:        { type: 'number', description: 'New severity 0-100' },
          tlp:             { type: 'string', enum: ['white', 'green', 'amber', 'red'], description: 'New TLP level' },
          tags:            { type: 'array', items: { type: 'string' }, description: 'Updated tags' },
          mitreAttackIds:  { type: 'array', items: { type: 'string' }, description: 'Updated MITRE ATT&CK IDs' },
        },
        required: ['investigationId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_link_incident',
      description: 'Link an existing incident to an investigation.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
          incidentId:      { type: 'string', description: 'The incident ID to link' },
        },
        required: ['investigationId', 'incidentId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'investigation_merge',
      description: 'Propose merging two investigations. Requires analyst confirmation — Warden can only suggest.',
      parameters: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'The target investigation (survives the merge)' },
          sourceId: { type: 'string', description: 'The source investigation (merged into target)' },
          reason:   { type: 'string', description: 'Why these investigations should be merged' },
        },
        required: ['targetId', 'sourceId', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'observable_add',
      description: 'Add an observable (IP, domain, hash, URL, etc.) to an investigation.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
          value:           { type: 'string', description: 'Observable value (e.g. IP, domain, hash)' },
          category:        { type: 'string', enum: ['ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn'], description: 'Observable category' },
          role:            { type: 'string', enum: ['ioc', 'artifact', 'infrastructure'], description: 'Observable role (default: ioc)' },
          verdict:         { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'], description: 'Verdict (default: unknown)' },
          confidence:      { type: 'number', description: 'Confidence 0-100. Malicious requires >= 80.' },
          context:         { type: 'string', description: 'Where/how this observable was found' },
        },
        required: ['investigationId', 'value', 'category'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'observable_set_verdict',
      description: 'Update an observable verdict. Warden requires confidence >= 80 for malicious.',
      parameters: {
        type: 'object',
        properties: {
          observableId: { type: 'string', description: 'The observable ID' },
          verdict:      { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'], description: 'New verdict' },
          confidence:   { type: 'number', description: 'Confidence 0-100. Malicious requires >= 80.' },
          context:      { type: 'string', description: 'Reasoning for the verdict' },
        },
        required: ['observableId', 'verdict'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'timeline_add',
      description: 'Add a timeline entry to an investigation.',
      parameters: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'The investigation ID' },
          eventTime:       { type: 'string', description: 'When the event occurred (ISO 8601)' },
          eventType:       { type: 'string', description: 'Event type: status_changed, action_taken, warden_annotation, etc.' },
          title:           { type: 'string', description: 'Short title' },
          description:     { type: 'string', description: 'Detailed description' },
        },
        required: ['investigationId', 'eventTime', 'eventType', 'title'],
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

      // ── SOC Case Management ──────────────────────────────────────────────

      case 'investigation_search': {
        const where: Record<string, unknown> = {}
        const status = args.status ? String(args.status) : null
        const search = args.search ? String(args.search) : null
        const severity = args.severity ? Number(args.severity) : null
        if (status) where.status = status
        if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }]
        if (severity) where.severity = { gte: severity }
        const invs = await prisma.investigation.findMany({
          where, orderBy: { createdAt: 'desc' }, take: 25,
          select: {
            id: true, name: true, status: true, severity: true, tlp: true,
            tags: true, startedAt: true,
            _count: { select: { incidents: true, notes: true, observables: true } },
          },
        })
        const total = await prisma.investigation.count({ where })
        return `Found ${total} investigations (showing ${invs.length}):\n` +
          invs.map(i => `- [${i.status}] ${i.name} (sev:${i.severity}, tlp:${i.tlp}, incidents:${i._count.incidents}, notes:${i._count.notes}, observables:${i._count.observables})`).join('\n')
      }

      case 'investigation_create': {
        const name = String(args.name ?? '').trim()
        if (!name) return 'Error: name is required'
        const inv = await prisma.investigation.create({
          data: {
            name,
            severity: args.severity ? Number(args.severity) : 50,
            tlp: (args.tlp as any) ?? 'amber',
            tags: (args.tags as string[]) ?? [],
            mitreAttackIds: (args.mitreAttackIds as string[]) ?? [],
            createdBy: 'warden',
          },
        })
        if (args.incidentId) {
          await prisma.incident.updateMany({
            where: { id: String(args.incidentId), investigationId: null },
            data: { investigationId: inv.id },
          })
          return `Investigation created: "${inv.name}" (id: ${inv.id}). Incident ${args.incidentId} linked.`
        }
        return `Investigation created: "${inv.name}" (id: ${inv.id}, status: open, severity: ${inv.severity})`
      }

      case 'investigation_read': {
        const investigationId = String(args.investigationId ?? '').trim()
        if (!investigationId) return 'Error: investigationId is required'
        const inv = await prisma.investigation.findUnique({
          where: { id: investigationId },
          include: {
            incidents: { orderBy: { openedAt: 'desc' }, take: 20 },
            notes: { orderBy: { createdAt: 'desc' }, take: 20 },
            observables: { orderBy: { firstSeen: 'desc' }, take: 50 },
            timeline: { orderBy: { eventTime: 'asc' }, take: 50 },
          },
        })
        if (!inv) return `Investigation ${investigationId} not found`
        return `Investigation: "${inv.name}"\nStatus: ${inv.status} | Severity: ${inv.severity} | TLP: ${inv.tlp}\n` +
          `Incidents: ${inv.incidents.length} | Notes: ${inv.notes.length} | Observables: ${inv.observables.length} | Timeline: ${inv.timeline.length}\n` +
          (inv.resolution ? `Resolution: ${inv.resolution}\n` : '') +
          (inv.observables.length > 0 ? `\nObservables:\n` + inv.observables.map(o => `  - [${o.category}] ${o.value} (${o.verdict}, conf:${o.confidence}%)`).join('\n') : '') +
          (inv.incidents.length > 0 ? `\nIncidents:\n` + inv.incidents.map(i => `  - [${i.status}] ${i.attackerKey ?? 'Unknown'} (sev:${i.severity})`).join('\n') : '')
      }

      case 'investigation_note': {
        const investigationId = String(args.investigationId ?? '').trim()
        const content = String(args.content ?? '').trim()
        if (!investigationId || !content) return 'Error: investigationId and content are required'
        const existing = await prisma.investigation.findUnique({ where: { id: investigationId } })
        if (!existing) return `Investigation ${investigationId} not found`
        const note = await prisma.investigationNote.create({
          data: { investigationId, content, author: 'warden', authorType: 'warden' },
        })
        await prisma.investigationTimeline.create({
          data: {
            investigationId, eventTime: new Date(), eventType: 'note_added',
            title: 'Warden note added', source: 'warden',
          },
        })
        return `Note added (id: ${note.id}) to investigation ${investigationId}`
      }

      case 'investigation_update': {
        const investigationId = String(args.investigationId ?? '').trim()
        if (!investigationId) return 'Error: investigationId is required'
        const inv = await prisma.investigation.findUnique({ where: { id: investigationId } })
        if (!inv) return `Investigation ${investigationId} not found`
        const data: Record<string, unknown> = {}
        if (args.status) data.status = String(args.status)
        if (args.severity != null) data.severity = Number(args.severity)
        if (args.tlp) data.tlp = String(args.tlp)
        if (args.tags) data.tags = args.tags as string[]
        if (args.mitreAttackIds) data.mitreAttackIds = args.mitreAttackIds as string[]
        const updated = await prisma.investigation.update({ where: { id: investigationId }, data })
        if (data.status) {
          await prisma.investigationTimeline.create({
            data: {
              investigationId, eventTime: new Date(), eventType: 'status_changed',
              title: `Status: ${inv.status} → ${updated.status}`, source: 'warden',
            },
          })
        }
        return `Investigation updated: ${Object.keys(data).map(k => `${k}: ${String(data[k])}`).join(', ')} (id: ${updated.id})`
      }

      case 'investigation_link_incident': {
        const investigationId = String(args.investigationId ?? '').trim()
        const incidentId = String(args.incidentId ?? '').trim()
        if (!investigationId || !incidentId) return 'Error: investigationId and incidentId are required'
        const [inv, inc] = await Promise.all([
          prisma.investigation.findUnique({ where: { id: investigationId } }),
          prisma.incident.findUnique({ where: { id: incidentId } }),
        ])
        if (!inv) return `Investigation ${investigationId} not found`
        if (!inc) return `Incident ${incidentId} not found`
        if (inc.investigationId && inc.investigationId !== investigationId) {
          return `Incident ${incidentId} already linked to investigation ${inc.investigationId}`
        }
        await prisma.incident.update({
          where: { id: incidentId },
          data: { investigationId },
        })
        await prisma.investigationTimeline.create({
          data: {
            investigationId, eventTime: new Date(), eventType: 'link_added',
            title: `Incident linked: ${inc.attackerKey ?? incidentId}`, source: 'warden',
          },
        })
        return `Incident ${incidentId} linked to investigation ${investigationId}`
      }

      case 'investigation_merge': {
        const targetId = String(args.targetId ?? '').trim()
        const sourceId = String(args.sourceId ?? '').trim()
        const reason = String(args.reason ?? '').trim()
        if (!targetId || !sourceId) return 'Error: targetId and sourceId are required'
        if (targetId === sourceId) return 'Error: cannot merge an investigation into itself'
        const [target, source] = await Promise.all([
          prisma.investigation.findUnique({ where: { id: targetId } }),
          prisma.investigation.findUnique({ where: { id: sourceId } }),
        ])
        if (!target) return `Target investigation ${targetId} not found`
        if (!source) return `Source investigation ${sourceId} not found`
        // Warden can only suggest, not execute
        return `MERGE SUGGESTION: "${source.name}" → "${target.name}"\nReason: ${reason}\nNote: Analyst confirmation required to execute merge. Use the investigation merge endpoint to confirm.`
      }

      case 'observable_add': {
        const investigationId = String(args.investigationId ?? '').trim()
        const value = String(args.value ?? '').trim()
        const category = String(args.category ?? '').trim()
        if (!investigationId || !value || !category) return 'Error: investigationId, value, and category are required'
        const inv = await prisma.investigation.findUnique({ where: { id: investigationId } })
        if (!inv) return `Investigation ${investigationId} not found`
        const verdict = (args.verdict as any) ?? 'unknown'
        const confidence = args.confidence ? Number(args.confidence) : 0
        if (verdict === 'malicious' && confidence < 80) {
          return 'Error: Warden requires confidence >= 80 to set malicious verdict'
        }
        const obs = await prisma.investigationObservable.upsert({
          where: {
            investigationId_value_category: { investigationId, value, category },
          },
          create: {
            investigationId, value, displayValue: value, category,
            role: (args.role as any) ?? 'ioc',
            verdict, confidence,
            context: args.context ? String(args.context) : 'Added by Warden',
            verdictBy: verdict !== 'unknown' ? 'warden' : undefined,
            verdictAt: verdict !== 'unknown' ? new Date() : undefined,
          },
          update: { lastSeen: new Date() },
        })
        return `Observable added: [${category}] ${value} (verdict: ${verdict}, confidence: ${confidence}%, id: ${obs.id})`
      }

      case 'observable_set_verdict': {
        const observableId = String(args.observableId ?? '').trim()
        const verdict = String(args.verdict ?? '').trim()
        const confidence = args.confidence ? Number(args.confidence) : undefined
        if (!observableId || !verdict) return 'Error: observableId and verdict are required'
        if (verdict === 'malicious' && (confidence ?? 0) < 80) {
          return 'Error: Warden requires confidence >= 80 to set malicious verdict'
        }
        const obs = await prisma.investigationObservable.findUnique({ where: { id: observableId } })
        if (!obs) return `Observable ${observableId} not found`
        const updated = await prisma.investigationObservable.update({
          where: { id: observableId },
          data: {
            verdict: verdict as any,
            confidence: confidence ?? obs.confidence,
            verdictBy: 'warden',
            verdictAt: new Date(),
            ...(args.context ? { context: String(args.context) } : {}),
          },
        })
        return `Verdict set: [${updated.category}] ${updated.value} → ${verdict} (confidence: ${updated.confidence}%)`
      }

      case 'timeline_add': {
        const investigationId = String(args.investigationId ?? '').trim()
        const eventTime = String(args.eventTime ?? '').trim()
        const eventType = String(args.eventType ?? '').trim()
        const title = String(args.title ?? '').trim()
        if (!investigationId || !eventTime || !eventType || !title) {
          return 'Error: investigationId, eventTime, eventType, and title are required'
        }
        const inv = await prisma.investigation.findUnique({ where: { id: investigationId } })
        if (!inv) return `Investigation ${investigationId} not found`
        const entry = await prisma.investigationTimeline.create({
          data: {
            investigationId,
            eventTime: new Date(eventTime),
            eventType,
            title,
            description: args.description ? String(args.description) : undefined,
            source: 'warden',
          },
        })
        return `Timeline entry added: "${title}" (id: ${entry.id})`
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
