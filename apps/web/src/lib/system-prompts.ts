/**
 * System Prompts Library
 *
 * All hardcoded agent instructions are stored here as defaults.
 * Admins can override any prompt via Administration → Prompts.
 * Values are cached in-memory for 60s to avoid DB hits on every stream.
 */

import { prisma } from './db'
import { promptText } from '@/prompts'

const cache = new Map<string, { content: string; ts: number }>()
const CACHE_TTL = 60_000

export interface PromptVariable {
  name: string
  description: string
}

export interface PromptDef {
  key: string
  name: string
  description: string
  category: 'system' | 'bootstrap' | 'context'
  content: string
  variables?: PromptVariable[]
}

// ── Defaults ─────────────────────────────────────────────────────────────────
// These are the factory defaults. Once a key is first accessed it is upserted
// into the DB; subsequent edits via the admin UI take effect immediately.

export const PROMPT_DEFAULTS: PromptDef[] = [
  // ── System prompts ─────────────────────────────────────────────────────────

  {
    key: 'system.main',
    name: 'Main Assistant — With Gateway',
    category: 'system',
    description: 'Core system prompt used when a gateway is connected and tools are available. Injected automatically: {{toolCount}}, {{toolList}}, {{clusterContext}}.',
    variables: [
      { name: '{{toolCount}}',      description: 'Number of connected MCP tools' },
      { name: '{{toolList}}',       description: 'Comma-separated list of tool names' },
      { name: '{{clusterContext}}', description: 'Contents of CLAUDE.md mounted at startup' },
    ],
    content: promptText('system/system.main'),
  },

  {
    key: 'system.main.no-gateway',
    name: 'Main Assistant — No Gateway',
    category: 'system',
    description: 'System prompt variant used when no gateway is connected. Placeholder: {{persona}}.',
    variables: [
      { name: '{{persona}}', description: 'Agent persona line (from agent definition or default)' },
    ],
    content: promptText('system/system.main.no-gateway'),
  },

  {
    key: 'system.planning',
    name: 'Planning Assistant System Prompt',
    category: 'system',
    description: 'Used during epic/feature/task planning sessions. Injected: {{scope}}, {{generateType}}, {{clusterContext}}.',
    variables: [
      { name: '{{scope}}',          description: 'What is being planned, e.g. "high-level epic (will be broken into features)"' },
      { name: '{{generateType}}',   description: '"features" for epics, "tasks" for features/tasks' },
      { name: '{{clusterContext}}', description: 'Contents of CLAUDE.md mounted at startup' },
    ],
    content: promptText('system/system.planning'),
  },

  {
    key: 'system.plan-review',
    name: 'Plan Review System Prompt (Opus)',
    category: 'system',
    description: 'Used by the Opus review pass to refine draft plans. No dynamic variables.',
    content: promptText('system/system.plan-review'),
  },

  {
    key: 'system.task-execution',
    name: 'Task Execution Prompt',
    category: 'system',
    description: 'Opening instruction when an AI agent picks up a task. Injected: {{taskTitle}}, {{taskDescription}}, {{taskPlan}}.',
    variables: [
      { name: '{{taskTitle}}',       description: 'Title of the task' },
      { name: '{{taskDescription}}', description: 'Task description (may be empty)' },
      { name: '{{taskPlan}}',        description: 'Implementation plan (may be empty)' },
    ],
    content: promptText('system/system.task-execution'),
  },

  // ── Bootstrap contexts ──────────────────────────────────────────────────────

  {
    key: 'bootstrap.cluster',
    name: 'Cluster Bootstrap Instructions',
    category: 'bootstrap',
    description: 'Initial context sent to the agent when bootstrapping a Kubernetes cluster. Injected: {{envId}}, {{envName}}.',
    variables: [
      { name: '{{envId}}',   description: 'Environment database ID' },
      { name: '{{envName}}', description: 'Environment display name' },
    ],
    content: promptText('system/bootstrap.cluster'),
  },

  {
    key: 'bootstrap.docker',
    name: 'Docker Bootstrap Instructions',
    category: 'bootstrap',
    description: 'Initial context sent to the agent when bootstrapping a remote Docker host. Injected: {{envId}}, {{envName}}.',
    variables: [
      { name: '{{envId}}',   description: 'Environment database ID' },
      { name: '{{envName}}', description: 'Environment display name' },
    ],
    content: promptText('system/bootstrap.docker'),
  },

  // ── Initial contexts ────────────────────────────────────────────────────────

  {
    key: 'context.pod-debug',
    name: 'Pod Debug Initial Context',
    category: 'context',
    description: 'Sent when starting a debug session from the Infrastructure pod table. Injected: {{podName}}, {{namespace}}, {{node}}, {{status}}, {{restarts}}.',
    variables: [
      { name: '{{podName}}',   description: 'Pod name' },
      { name: '{{namespace}}', description: 'Kubernetes namespace' },
      { name: '{{node}}',      description: 'Node the pod is running on' },
      { name: '{{status}}',    description: 'Pod status string' },
      { name: '{{restarts}}',  description: 'Restart count' },
    ],
    content: promptText('system/context.pod-debug'),
  },

  {
    key: 'context.epic-plan',
    name: 'Epic Planning Initial Context',
    category: 'context',
    description: 'Sent when opening a planning chat for an epic. Injected: {{title}}, {{description}}.',
    variables: [
      { name: '{{title}}',       description: 'Epic title' },
      { name: '{{description}}', description: 'Epic description (may be empty)' },
    ],
    content: promptText('system/context.epic-plan'),
  },

  {
    key: 'context.feature-plan',
    name: 'Feature Planning Initial Context',
    category: 'context',
    description: 'Sent when opening a planning chat for a feature. Injected: {{title}}, {{description}}. Parent epic context is appended automatically.',
    variables: [
      { name: '{{title}}',       description: 'Feature title' },
      { name: '{{description}}', description: 'Feature description (may be empty)' },
      { name: '{{parentContext}}', description: 'Parent epic context (auto-injected)' },
    ],
    content: promptText('system/context.feature-plan'),
  },

  {
    key: 'system.feature-planning-prefix',
    name: 'Feature Planning — Task Creation Prefix',
    category: 'system',
    description: 'Prepended to the feature-planning chat context. Instructs the planning agent to decompose the feature into dependency-ordered tasks via orion_create_task. No dynamic variables.',
    content: promptText('system/system.feature-planning-prefix'),
  },

  {
    key: 'context.task-plan',
    name: 'Task Planning Initial Context',
    category: 'context',
    description: 'Sent when opening a planning chat for a task. Injected: {{title}}, {{description}}. Parent feature and epic context is appended automatically.',
    variables: [
      { name: '{{title}}',       description: 'Task title' },
      { name: '{{description}}', description: 'Task description (may be empty)' },
      { name: '{{parentContext}}', description: 'Parent feature/epic context (auto-injected)' },
    ],
    content: promptText('system/context.task-plan'),
  },

  {
    key: 'system.task-runner-tools',
    name: 'Task Runner — Tool Awareness Preamble',
    category: 'system',
    description: 'Prepended to every task-running agent\'s system prompt. Lists available management tools and gateway tools. Injected: {{toolList}}.',
    variables: [
      { name: '{{toolList}}', description: 'Newline-separated list of available tool names and descriptions' },
    ],
    content: promptText('system/system.task-runner-tools'),
  },

  {
    key: 'system.task-plan-prefix',
    name: 'Task Plan Prefix',
    category: 'system',
    description: 'Prepended to a task agent\'s system prompt when planBeforeExecute is enabled. Requires the agent to emit a structured XML plan (steps, risk_level, verify_steps, rollback_steps) before taking any actions, then verify the outcome and roll back on failure. ORION pauses high/critical-risk plans for human/supervisor approval.',
    content: promptText('system/system.task-plan-prefix'),
  },

  {
    key: 'system.agent-creation',
    name: 'Agent Creation Planning System Prompt',
    category: 'system',
    description: 'System prompt used during the "Plan with AI" agent creation flow from the Team panel. No dynamic variables.',
    content: promptText('system/system.agent-creation'),
  },

  {
    key: 'context.agent-create',
    name: 'New Agent Creation Context',
    category: 'context',
    description: 'Auto-sent as the first message when a user starts the "Plan with AI" agent creation flow. No dynamic variables.',
    content: promptText('system/context.agent-create'),
  },

  // ── Ring Leader ────────────────────────────────────────────────────────────────

  {
    key: 'system.ring-leader',
    name: 'Ring Leader System Prompt',
    category: 'system',
    description: 'Core prompt for the ring leader — the agent responsible for orchestrating a chat room. Handles human messages, decides whether to delegate to specialist agents, and manages room conversation. Injected: {{agentName}}, {{agentPrompt}}, {{specialists}}.',
    variables: [
      { name: '{{agentName}}',       description: 'Ring leader agent name' },
      { name: '{{agentPrompt}}',     description: 'Ring leader\'s system prompt (from agent definition)' },
      { name: '{{specialists}}',     description: 'List of discoverable specialists (from agent profiles)' },
    ],
    content: promptText('system/system.ring-leader'),
  },

  {
    key: 'system.specialist-context',
    name: 'Specialist Agent Context Prompt',
    category: 'system',
    description: 'Appended to a specialist agent\'s system prompt when they receive a delegated task. Injected: {{delegationContext}}, {{directives}}.',
    variables: [
      { name: '{{delegationContext}}', description: 'Context of the delegated task from the ring leader' },
      { name: '{{directives}}',        description: 'Specific instructions from the ring leader' },
    ],
    content: promptText('system/system.specialist-context'),
  },
]

const DEFAULT_MAP = new Map(PROMPT_DEFAULTS.map(p => [p.key, p]))

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a prompt by key. Falls back to the hardcoded default if not in DB yet
 * (and seeds it). Throws for a key with no default and no DB row — previously
 * a typo silently upserted a permanent empty prompt.
 */
export async function getPrompt(key: string): Promise<string> {
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.content

  const def = DEFAULT_MAP.get(key)
  if (!def) {
    const existing = await prisma.systemPrompt.findUnique({ where: { key } })
    if (!existing) throw new Error(`Unknown system prompt key: "${key}"`)
    cache.set(key, { content: existing.content, ts: Date.now() })
    return existing.content
  }

  const record = await prisma.systemPrompt.upsert({
    where: { key },
    update: {},
    create: {
      key,
      name: def.name,
      description: def.description ?? null,
      category: def.category ?? 'system',
      content: def.content,
      variables: (def.variables ?? null) as unknown as object,
    },
  })

  cache.set(key, { content: record.content, ts: Date.now() })
  return record.content
}

/** Substitute {{varName}} placeholders in a template string. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => vars[key] ?? '')
}

/** Invalidate the in-memory cache for a key (call after admin saves). */
export function invalidatePromptCache(key: string) {
  cache.delete(key)
}
