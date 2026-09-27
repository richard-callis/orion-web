/**
 * Room-only ORION tools, registered in the unified tool registry.
 *
 * These used to live in agent-tools.ts as a second, parallel tool
 * implementation that room agents called directly — bypassing the registry's
 * tier checks, audit logging, and (for create_agent) the reserved-name check,
 * system-prompt validation, and MAX_ACTIVE_AGENTS cap. They are now registry
 * tools with availableIn: 'room', so room-agents.ts executes them through
 * executeRegisteredTool + checkToolPermission like every other tool.
 *
 * Tools that already had a registry equivalent were dropped rather than moved:
 *   orion_get_tasks  → orion_list_tasks
 *   orion_get_agents → orion_list_agents
 *   generate_secret, investigation_*, observable_*, timeline_add → registry versions
 *
 * Every handler requires ctx.roomId, so these can't be reached from the task
 * or human-chat paths even by name.
 */

import { prisma } from './db'
import { updateVaultSecret } from './vault'
import { getOrFetch } from './system-cache'
import {
  registerTool,
  getAllTools,
  getToolDefinition,
  executeRegisteredTool,
  type ToolDefinition,
  type ToolExecutionContext,
} from './tool-registry'

const TASK_STATUSES   = ['pending', 'in_progress', 'pending_validation', 'done', 'failed', 'blocked']
const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical']

type Args = Record<string, unknown>

function asArgs(args: unknown): Args {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Args : {}
}

function roomOnly(name: string, handler: (args: Args, ctx: ToolExecutionContext & { roomId: string }) => Promise<string>) {
  return async (args: unknown, ctx: ToolExecutionContext): Promise<string> => {
    if (!ctx.roomId) return `Error: ${name} is only available to agents in a chat room.`
    return handler(asArgs(args), ctx as ToolExecutionContext & { roomId: string })
  }
}

async function roomAuditLog(agentId: string | undefined, content: string): Promise<void> {
  if (!agentId) return
  await prisma.agentMessage.create({
    data: { agentId, channel: 'agent-feed', content, messageType: 'task_update' },
  }).catch(e => console.error('[room-tools] auditLog write failed:', e instanceof Error ? e.message : e))
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

async function handleCreateTask(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const status   = String(args.status   ?? 'pending')
  const priority = String(args.priority ?? 'medium')
  if (!TASK_STATUSES.includes(status))     return `Error: invalid status '${status}'. Must be one of: ${TASK_STATUSES.join(', ')}`
  if (!TASK_PRIORITIES.includes(priority)) return `Error: invalid priority '${priority}'. Must be one of: ${TASK_PRIORITIES.join(', ')}`
  const task = await ctx.prisma.task.create({
    data: {
      title:         String(args.title ?? 'Untitled Task'),
      description:   args.description ? String(args.description) : undefined,
      priority,
      status,
      createdBy:     ctx.agentId,
      assignedAgent: ctx.agentId,
    },
  })
  await roomAuditLog(ctx.agentId, `📋 Created task **${task.title}** (\`${task.id}\`)`)
  return `Task created: "${task.title}" (id: ${task.id}, status: ${task.status}, priority: ${task.priority})`
}

async function handleUpdateTask(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const taskId = String(args.taskId ?? '')
  if (!taskId) return 'Error: taskId is required'
  const existing = await ctx.prisma.task.findUnique({ where: { id: taskId } })
  if (!existing) return `Error: task ${taskId} not found`
  if (args.status != null && !TASK_STATUSES.includes(String(args.status))) {
    return `Error: invalid status '${args.status}'. Must be one of: ${TASK_STATUSES.join(', ')}`
  }
  if (args.priority != null && !TASK_PRIORITIES.includes(String(args.priority))) {
    return `Error: invalid priority '${args.priority}'. Must be one of: ${TASK_PRIORITIES.join(', ')}`
  }
  const updated = await ctx.prisma.task.update({
    where: { id: taskId },
    data: {
      title:       args.title       ? String(args.title)       : undefined,
      description: args.description ? String(args.description) : undefined,
      status:      args.status   != null ? String(args.status)   : undefined,
      priority:    args.priority != null ? String(args.priority) : undefined,
    },
  })
  await roomAuditLog(ctx.agentId, `✏️ Updated task **${updated.title}** (\`${updated.id}\`)`)
  return `Task updated: "${updated.title}" (id: ${updated.id}, status: ${updated.status})`
}

async function handleManageTask(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const taskId = String(args.taskId ?? '')
  if (!taskId) return 'Error: taskId is required'
  const existing = await ctx.prisma.task.findUnique({ where: { id: taskId } })
  if (!existing) return `Error: task ${taskId} not found`
  if (args.status && !TASK_STATUSES.includes(String(args.status))) {
    return `Error: invalid status '${args.status}'. Must be one of: ${TASK_STATUSES.join(', ')}`
  }
  const data: Record<string, unknown> = {}
  if (args.assignedAgent) data.assignedAgent = String(args.assignedAgent)
  if (args.status)        data.status        = String(args.status)
  const updated = Object.keys(data).length > 0
    ? await ctx.prisma.task.update({ where: { id: taskId }, data })
    : existing
  if (args.note) {
    await ctx.prisma.taskEvent.create({ data: { taskId, eventType: 'note', content: String(args.note) } })
  }
  await roomAuditLog(ctx.agentId, `🗂️ Managed task **${updated.title}** (\`${taskId}\`)`)
  return `Task "${updated.title}" (${taskId}): status=${updated.status}, assigned=${updated.assignedAgent ?? 'unassigned'}${args.note ? ', note appended' : ''}`
}

// ── Agents ────────────────────────────────────────────────────────────────────

/**
 * create_agent — delegates creation to the registry's orion_create_agent (which
 * enforces reserved names, system-prompt validation, the active-agent cap and
 * audit logging), then invites the new agent into the calling room.
 */
async function handleCreateAgentInRoom(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  let llm = args.llm ? String(args.llm) : undefined
  if (!llm && ctx.agentId) {
    // Default to the calling agent's own model, as the legacy tool did
    const caller = await ctx.prisma.agent.findUnique({ where: { id: ctx.agentId }, select: { metadata: true } })
    const cfg = ((caller?.metadata as Record<string, unknown> | null)?.contextConfig ?? {}) as Record<string, unknown>
    if (typeof cfg.llm === 'string') llm = cfg.llm
  }

  const result = await executeRegisteredTool('orion_create_agent', {
    name:         args.name,
    role:         args.role ?? 'Room agent',
    systemPrompt: args.systemPrompt,
    ...(llm && { llm }),
  }, ctx)

  let created: { id?: string; name?: string; note?: string }
  try { created = JSON.parse(result) } catch { return result }  // an error string
  if (!created.id) return result
  if (created.note) return `Error: an agent named "${created.name}" already exists (id: ${created.id})`

  await ctx.prisma.chatRoomMember.create({ data: { roomId: ctx.roomId, agentId: created.id, role: 'member' } })
  await ctx.prisma.chatMessage.create({
    data: { roomId: ctx.roomId, senderType: 'system', content: `${created.name} has joined the room.` },
  })
  return `Agent created and invited: "${created.name}" (id: ${created.id}${llm ? `, llm: ${llm}` : ''})`
}

// ── Secrets ───────────────────────────────────────────────────────────────────

async function handleWriteSecret(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const environmentName = String(args.environmentName ?? '').trim()
  const name            = String(args.name ?? '').trim()
  const vaultPath       = String(args.vaultPath ?? '').trim()
  const keyNames        = Array.isArray(args.keyNames) ? (args.keyNames as unknown[]).map(String).filter(Boolean) : []

  if (!environmentName) return 'Error: environmentName is required'
  if (!name)            return 'Error: name is required'
  if (!vaultPath)       return 'Error: vaultPath is required'
  if (keyNames.length === 0) return 'Error: keyNames must contain at least one key'

  const env = await ctx.prisma.environment.findUnique({ where: { name: environmentName } })
  if (!env) {
    const all = await ctx.prisma.environment.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
    const names = all.map((e: { name: string }) => `"${e.name}"`).join(', ')
    return `Error: environment "${environmentName}" not found. Available environments: ${names || 'none'}.`
  }

  // Enforce vault path convention: must be under the environment's vaultPathPrefix
  const prefix = (env as Record<string, unknown>).vaultPathPrefix as string | undefined
  const normalizedPath = vaultPath.replace(/^secret\/data\//, '')
  if (prefix) {
    const normalizedPrefix = prefix.replace(/\/$/, '')
    if (!normalizedPath.startsWith(normalizedPrefix + '/') && normalizedPath !== normalizedPrefix) {
      return `Error: vaultPath "${vaultPath}" is outside this environment's allowed prefix "${normalizedPrefix}/". Use a path like "${normalizedPrefix}/<service-name>".`
    }
  }

  // Idempotency guard: refuse to overwrite an already-applied secret
  const existing = await ctx.prisma.managedSecret.findFirst({
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
    return [
      `Secret "${name}" already exists in draft state (id: ${existing.id}) — not creating a duplicate.`,
      `  Vault path: secret/data/${existing.remoteRef}`,
      `  Status:    draft (waiting for real values)`,
      ``,
      `Next step: open Infrastructure > External Secrets in environment "${environmentName}", find "${name}", and click the pencil icon to enter the real values.`,
    ].join('\n')
  }

  const namespace        = String(args.namespace ?? 'default').trim() || 'default'
  const description      = args.description      ? String(args.description).trim() : null
  const targetSecretName = args.targetSecretName ? String(args.targetSecretName).trim() || null : null
  const refreshInterval  = String(args.refreshInterval ?? '1h').trim() || '1h'

  const placeholderData: Record<string, string> = {}
  for (const key of keyNames) placeholderData[key] = 'PLACEHOLDER'
  try {
    // Never clobber real values already at this path with placeholders
    await updateVaultSecret(normalizedPath, placeholderData, [], { onlyMissing: true })
  } catch (e) {
    return `Error: failed to write placeholder to Vault: ${e instanceof Error ? e.message : String(e)}`
  }

  const secret = await ctx.prisma.managedSecret.create({
    data: {
      environmentId:   env.id,
      createdBy:       null,
      name,
      namespace,
      description,
      secretStore:     'vault-backend',
      secretStoreKind: 'ClusterSecretStore',
      remoteRef:       normalizedPath,
      targetSecretName,
      refreshInterval,
      dataKeys:        keyNames.map(k => ({ remoteKey: k, secretKey: k })),
      tags:            [],
      status:          'draft',
    },
  })
  await roomAuditLog(ctx.agentId, `🔐 Scaffolded secret **${secret.name}** (\`${secret.id}\`) in ${environmentName}`)

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

async function handleUpdateSecret(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const secretId = String(args.secretId ?? '').trim()
  if (!secretId) return 'Error: secretId is required'

  const existing = await ctx.prisma.managedSecret.findUnique({ where: { id: secretId } })
  if (!existing) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`

  const data: Record<string, unknown> = {}
  if (args.namespace   != null) data.namespace   = String(args.namespace).trim()
  if (args.description != null) data.description = String(args.description).trim() || null
  if (args.vaultPath != null) {
    // Enforce the environment's vault prefix, as write_secret does
    const newPath = String(args.vaultPath).trim().replace(/^secret\/data\//, '')
    if (existing.environmentId) {
      const env = await ctx.prisma.environment.findUnique({ where: { id: existing.environmentId }, select: { metadata: true } })
      const vaultPrefix = ((env?.metadata ?? {}) as Record<string, unknown>).vaultPathPrefix as string | undefined
      if (vaultPrefix && !newPath.startsWith(vaultPrefix)) {
        return `Error: vaultPath must be under the environment's vault prefix: "${vaultPrefix}". Got: "${newPath}"`
      }
    }
    data.remoteRef = newPath
  }
  if (args.targetSecretName != null) data.targetSecretName = String(args.targetSecretName).trim() || null
  if (args.refreshInterval  != null) data.refreshInterval  = String(args.refreshInterval).trim() || '1h'
  if (Array.isArray(args.keyNames)) {
    const keys = (args.keyNames as unknown[]).map(String).filter(Boolean)
    if (keys.length > 0) data.dataKeys = keys.map(k => ({ remoteKey: k, secretKey: k }))
  }

  if (Object.keys(data).length === 0) return 'Error: no fields to update — provide at least one of: namespace, description, vaultPath, keyNames, targetSecretName, refreshInterval'

  const updated = await ctx.prisma.managedSecret.update({ where: { id: secretId }, data })
  await roomAuditLog(ctx.agentId, `🔐 Updated secret **${updated.name}** (\`${secretId}\`): ${Object.keys(data).join(', ')}`)
  return [
    `Secret "${updated.name}" (${secretId}) updated:`,
    ...Object.keys(data).map(k => `  ${k}: ${JSON.stringify((updated as Record<string, unknown>)[k])}`),
  ].join('\n')
}

async function handleDeleteSecret(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const secretId = String(args.secretId ?? '').trim()
  if (!secretId) return 'Error: secretId is required'

  const existing = await ctx.prisma.managedSecret.findUnique({ where: { id: secretId } })
  if (!existing) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`

  // Don't silently orphan a live (applied) Vault + K8s secret without force
  if (existing.status === 'applied' && !args.force) {
    return `Error: secret "${existing.name}" is applied (live Vault + K8s Secret). Deleting the ORION record will orphan those resources. Pass force: true to proceed if you have already cleaned them up manually.`
  }

  await ctx.prisma.managedSecret.delete({ where: { id: secretId } })
  const reason = args.reason ? ` Reason: ${String(args.reason)}` : ''
  await roomAuditLog(ctx.agentId, `🗑️ Deleted secret record **${existing.name}** (\`${secretId}\`).${reason}`)
  return `Deleted ORION secret record "${existing.name}" (${secretId}) from namespace "${existing.namespace}".${reason}\nNote: Vault secret and K8s Secret (if applied) were NOT deleted — only the ORION metadata record.`
}

// ── SOC ───────────────────────────────────────────────────────────────────────

async function handleInvestigationMerge(args: Args, ctx: ToolExecutionContext & { roomId: string }): Promise<string> {
  const targetId = String(args.targetId ?? '').trim()
  const sourceId = String(args.sourceId ?? '').trim()
  const reason   = String(args.reason ?? '').trim()
  if (!targetId || !sourceId) return 'Error: targetId and sourceId are required'
  if (targetId === sourceId)  return 'Error: cannot merge an investigation into itself'
  const [target, source] = await Promise.all([
    ctx.prisma.investigation.findUnique({ where: { id: targetId } }),
    ctx.prisma.investigation.findUnique({ where: { id: sourceId } }),
  ])
  if (!target) return `Target investigation ${targetId} not found`
  if (!source) return `Source investigation ${sourceId} not found`
  // Suggestion only — an analyst confirms the merge
  return `MERGE SUGGESTION: "${source.name}" → "${target.name}"\nReason: ${reason}\nNote: Analyst confirmation required to execute merge. Use the investigation merge endpoint to confirm.`
}

// ── Registration ──────────────────────────────────────────────────────────────

const STATUS_ENUM   = ['pending', 'in_progress', 'done', 'blocked']
const PRIORITY_ENUM = ['low', 'medium', 'high']

const ROOM_TOOLS: ToolDefinition[] = [
  {
    name: 'create_task',
    description: 'Create a new task in ORION. Use this when a user asks you to log, track, or create a task.',
    inputSchema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed description of what needs to be done' },
        priority:    { type: 'string', enum: PRIORITY_ENUM, description: 'Task priority (default: medium)' },
        status:      { type: 'string', enum: STATUS_ENUM, description: 'Initial status (default: pending)' },
      },
      required: ['title'],
    },
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'tasks',
    handler: roomOnly('create_task', handleCreateTask),
  },
  {
    name: 'update_task',
    description: 'Update an existing task. Use this to change status, title, or description.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:      { type: 'string', description: 'The ID of the task to update' },
        title:       { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        status:      { type: 'string', enum: STATUS_ENUM, description: 'New status (optional)' },
        priority:    { type: 'string', enum: PRIORITY_ENUM, description: 'New priority (optional)' },
      },
      required: ['taskId'],
    },
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'tasks',
    handler: roomOnly('update_task', handleUpdateTask),
  },
  {
    name: 'orion_manage_task',
    description: 'Assign a task to an agent, update its status, or append a feed note.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:        { type: 'string', description: 'Task ID to act on' },
        assignedAgent: { type: 'string', description: 'Agent ID to assign the task to (optional)' },
        status:        { type: 'string', enum: STATUS_ENUM, description: 'New status (optional)' },
        note:          { type: 'string', description: 'Feed note to append to the task (optional)' },
      },
      required: ['taskId'],
    },
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'tasks',
    handler: roomOnly('orion_manage_task', handleManageTask),
  },
  {
    name: 'create_agent',
    description: 'Create a new AI agent and automatically invite it to the current chat room. Use this when asked to spin up, create, or add a new agent.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'Unique name for the agent (cannot be a reserved name: human, user, system, admin)' },
        role:         { type: 'string', description: 'Role or job title (e.g. "Creative Writer", "QA Engineer")' },
        systemPrompt: { type: 'string', description: 'Full system prompt defining the agent\'s personality and behavior (20–10,000 characters)' },
        llm:          { type: 'string', description: 'LLM identifier to use. Leave blank to use the same model as you.' },
      },
      required: ['name', 'systemPrompt'],
    },
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'agents',
    handler: roomOnly('create_agent', handleCreateAgentInRoom),
  },
  {
    name: 'write_secret',
    description: 'Create a skeleton External Secret in ORION backed by Vault. Writes PLACEHOLDER values to Vault so the human can fill in the real values inside ORION (Infrastructure > External Secrets > pencil icon). Use this when asked to scaffold, create, or set up a secret for a deployment.',
    inputSchema: {
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
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'secrets',
    handler: roomOnly('write_secret', handleWriteSecret),
  },
  {
    name: 'update_secret',
    description: 'Update metadata on an existing ORION-managed secret — namespace, description, key names, or Vault path. Use this to correct a secret that was created with the wrong namespace or other wrong values. Get the secret id from orion_list_secrets.',
    inputSchema: {
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
    tier: 'write', parallelSafe: false, availableIn: 'room', category: 'secrets',
    handler: roomOnly('update_secret', handleUpdateSecret),
  },
  {
    name: 'delete_secret',
    description: 'Delete an ORION-managed secret record. Only deletes the ORION metadata — does NOT delete the Vault secret or the K8s Secret. Use when a secret was created with wrong parameters and needs to be recreated, or when it is genuinely no longer needed. Get the secret id from orion_list_secrets. Requires a one-time tool grant.',
    inputSchema: {
      type: 'object',
      properties: {
        secretId: { type: 'string', description: 'The ORION secret id (from orion_list_secrets)' },
        reason:   { type: 'string', description: 'Why this secret is being deleted (for the audit log)' },
        force:    { type: 'boolean', description: 'Required to delete an applied (live) secret record' },
      },
      required: ['secretId'],
    },
    tier: 'destructive', parallelSafe: false, availableIn: 'room', category: 'secrets',
    handler: roomOnly('delete_secret', handleDeleteSecret),
  },
  {
    name: 'investigation_merge',
    description: 'Propose merging two investigations. Requires analyst confirmation — Warden can only suggest.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'The target investigation (survives the merge)' },
        sourceId: { type: 'string', description: 'The source investigation (merged into target)' },
        reason:   { type: 'string', description: 'Why these investigations should be merged' },
      },
      required: ['targetId', 'sourceId', 'reason'],
    },
    tier: 'read', parallelSafe: true, availableIn: 'room', category: 'security' as ToolDefinition['category'],
    handler: roomOnly('investigation_merge', handleInvestigationMerge),
  },
]

export const ROOM_TOOL_NAMES: ReadonlySet<string> = new Set(ROOM_TOOLS.map(t => t.name))

let registered = false
/** Idempotent — safe to call from every module that needs the room tools. */
export function registerRoomTools(): void {
  if (registered) return
  for (const def of ROOM_TOOLS) {
    // Never shadow an existing registry tool of the same name
    if (!getToolDefinition(def.name)) registerTool(def)
  }
  registered = true
}
registerRoomTools()

/** Registry tools offered to room agents: chat/both tools plus room-only tools. */
export function getRoomAgentTools(): ToolDefinition[] {
  return getAllTools().filter(t => t.availableIn === 'chat' || t.availableIn === 'both' || t.availableIn === 'room')
}

/** OpenAI function schemas for room agents, with live environment names injected into write_secret. */
export async function buildRoomToolSchemas(): Promise<Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>> {
  const envNames = await getOrFetch('environments', 'cache.environments.ttl', async () => {
    const envs = await prisma.environment.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
    return envs.map((e: { name: string }) => `"${e.name}"`).join(', ') || 'none configured'
  }).catch(() => 'unknown')

  return getRoomAgentTools().map(t => {
    let parameters = t.inputSchema
    if (t.name === 'write_secret') {
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>
      parameters = {
        ...t.inputSchema,
        properties: {
          ...props,
          environmentName: {
            type: 'string',
            description: `Name of the ORION environment to create the secret in. Available environments: ${envNames}.`,
          },
        },
      }
    }
    return { type: 'function' as const, function: { name: t.name, description: t.description, parameters } }
  })
}
