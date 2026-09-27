/**
 * Agent lifecycle tools: list, create, update, archive, spawn sub-agents, find specialists.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getDefaultModelId } from '@/lib/default-model'
import { RESERVED_AGENT_NAMES, auditLog, parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const ListAgentsArgs = z.object({
  include_archived: z.boolean().nullish(),
})

async function handleListAgents(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { include_archived } = parseToolArgs(ListAgentsArgs, args)
  const agents = await ctx.prisma.agent.findMany({
    orderBy: { name: 'asc' },
    include: { tasks: { where: { status: { in: ['in_progress', 'pending_validation'] } }, select: { id: true }, take: 1 } },
  })
  const filtered = include_archived
    ? agents
    : agents.filter((a) => !(a.metadata as Record<string, unknown> | null)?.archived)
  return JSON.stringify(
    filtered.map((a) => {
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

const CreateAgentArgs = z.object({
  name: z.string().nullish(),
  role: z.string().nullish(),
  systemPrompt: z.string().nullish(),
  type: z.string().nullish(),
  description: z.string().nullish(),
  persistent: z.boolean().nullish(),
  llm: z.string().nullish(),
  metadata: z.record(z.unknown()).nullish(),
})

async function handleCreateAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const spec = parseToolArgs(CreateAgentArgs, args)

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

const UpdateAgentArgs = z.object({
  agent_id: z.string().nullish(),
  role: z.string().nullish(),
  description: z.string().nullish(),
  systemPrompt: z.string().nullish(),
  llm: z.string().nullish(),
  mentorReviewedAt: z.string().nullish(),
})

async function handleUpdateAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const spec = parseToolArgs(UpdateAgentArgs, args)
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

const ArchiveAgentArgs = z.object({
  agent_id: z.string().nullish(),
  reason: z.string().nullish(),
})

async function handleArchiveAgent(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { agent_id, reason } = parseToolArgs(ArchiveAgentArgs, args)
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

// ── Register all tools ────────────────────────────────────────────────────────

export const orionListAgentsTool: ToolDefinition = {
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
}

export const orionCreateAgentTool: ToolDefinition = {
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
}

export const orionUpdateAgentTool: ToolDefinition = {
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
}

export const orionArchiveAgentTool: ToolDefinition = {
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
}

// ── spawn_agent ───────────────────────────────────────────────────────────────

const MAX_SUBAGENT_RESULT_CHARS = 12_000
const SUBAGENT_DEPTH_KEY = '__subagent_depth'

const SpawnAgentArgs = z.object({
  prompt: z.string().nullish(),
  system_prompt: z.string().nullish(),
  model: z.string().nullish(),
  max_turns: z.number().nullish(),
})

export const spawnAgentTool: ToolDefinition = {
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
    } = parseToolArgs(SpawnAgentArgs, args)

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
}

// ── Ring Leader: findSpecialist ──────────────────────────────────────────────

export const findSpecialistTool: ToolDefinition = {
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
    const scored = results.map((p) => {
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
}
