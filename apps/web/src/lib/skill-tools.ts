/**
 * Skill tools — let agents save, list, and use reusable step-by-step
 * procedures ("skills") on top of the existing NebulaInstance(category:'skill')
 * model that already powers automatic chat-trigger skill injection
 * (see matchAndInjectSkills in claude.ts).
 *
 * Skills are scoped per-environment, same as the Nebula UI's human-authored
 * skills. Agent-saved skills are auto-installed for retrieval (list_skills /
 * use_skill) immediately — that's a pull, the agent already chose to use it,
 * no different in risk from any other read tool. But their trigger_patterns
 * are capped in count/specificity (see MIN_TRIGGER_PATTERN_LEN etc. below)
 * because that's a PUSH path: matchAndInjectSkills auto-injects the first
 * matching skill's systemPrompt into every future chat turn whose message
 * contains the pattern, for every user in that environment — an overly broad
 * or adversarial pattern would hijack unrelated conversations. Dream's
 * skill-crafting phase (dream.ts) writes here too, tagged source:'dream',
 * and is held to the same caps.
 */

import { registerTool, type ToolExecutionContext } from '@/lib/tool-registry'
import { prisma } from '@/lib/db'

export interface SkillSpec {
  triggerPatterns?: string[]
  systemPrompt?: string
  steps?: string[]
  description?: string
}

// Caps on the auto-injecting (push) surface of a skill — bounds both cost
// (a huge systemPrompt gets prepended to every matching chat turn) and the
// blast radius of an overly broad/adversarial trigger pattern hijacking
// unrelated conversations. Enforced on both the agent self-save path and
// Dream's crafting path.
export const MIN_TRIGGER_PATTERN_LEN = 6
export const MAX_TRIGGER_PATTERNS    = 8
export const MAX_STEPS               = 20
export const MAX_STEP_LEN            = 500
export const MAX_SYSTEM_PROMPT_LEN   = 4000

/** Build the systemPrompt injected/returned for a skill from either explicit
 * instructions or an ordered step list. */
function buildSkillPrompt(systemPrompt: string | undefined, steps: string[] | undefined): string {
  if (systemPrompt?.trim()) return systemPrompt.trim()
  if (steps?.length) return steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return ''
}

/**
 * Validate a skill's push-surface (trigger patterns) and content size.
 * Returns an error string if invalid, or null if OK.
 */
export function validateSkillContent(
  triggerPatterns: string[] | undefined,
  systemPrompt: string,
  steps: string[] | undefined,
): string | null {
  if (triggerPatterns && triggerPatterns.length > MAX_TRIGGER_PATTERNS) {
    return `Too many trigger_patterns (${triggerPatterns.length}) — max ${MAX_TRIGGER_PATTERNS}.`
  }
  const tooShort = (triggerPatterns ?? []).find(p => p.trim().length < MIN_TRIGGER_PATTERN_LEN)
  if (tooShort !== undefined) {
    return `trigger_pattern "${tooShort}" is too short/broad (min ${MIN_TRIGGER_PATTERN_LEN} chars) — an overly generic pattern would auto-fire on unrelated chat messages.`
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_LEN) {
    return `Instructions are too long (${systemPrompt.length} chars) — max ${MAX_SYSTEM_PROMPT_LEN}.`
  }
  if (steps && steps.length > MAX_STEPS) {
    return `Too many steps (${steps.length}) — max ${MAX_STEPS}.`
  }
  const tooLongStep = (steps ?? []).find(s => s.length > MAX_STEP_LEN)
  if (tooLongStep !== undefined) {
    return `A step exceeds the max length of ${MAX_STEP_LEN} chars.`
  }
  return null
}

/**
 * Resolve which environment a skill call should target, and verify the
 * calling agent is actually linked to it. An explicitly-passed environment_id
 * is agent-controlled input — trusting it without this check would let any
 * agent read, list, or (worse) write auto-installed skills into an
 * environment it has no relationship to.
 */
async function resolveEnvironmentId(ctx: ToolExecutionContext, explicit?: string): Promise<string | { error: string }> {
  if (!ctx.agentId) return { error: 'No agent context — this tool requires an authenticated agent.' }

  if (explicit) {
    const link = await prisma.agentEnvironment.findFirst({ where: { agentId: ctx.agentId, environmentId: explicit } })
    if (!link) return { error: `Agent is not linked to environment "${explicit}" — cannot access skills scoped to it.` }
    return explicit
  }

  if (ctx.environmentId) return ctx.environmentId

  // Deterministic fallback (not just "first" — findFirst with no orderBy is
  // non-deterministic in Postgres) when no explicit/context environment is given.
  const link = await prisma.agentEnvironment.findFirst({
    where: { agentId: ctx.agentId },
    orderBy: { createdAt: 'asc' },
  })
  if (!link) return { error: 'No environment context — pass environment_id explicitly, or link this agent to an environment first.' }
  return link.environmentId
}

export function registerSkillTools(): void {
  registerTool({
    name: 'save_skill',
    description: 'Save a step-by-step procedure you figured out as a reusable skill, so you (or any agent) can look it up and reuse it later instead of re-deriving it. Use this once you have successfully worked out how to do something non-trivial that is likely to come up again.',
    inputSchema: {
      type: 'object',
      properties: {
        name:             { type: 'string', description: 'short kebab-case identifier, e.g. "restart-stuck-media-pod"' },
        description:      { type: 'string', description: 'One-sentence summary of what this skill does' },
        trigger_patterns: { type: 'array', items: { type: 'string' }, description: `Phrases that should auto-trigger this skill when they appear in a user message (case-insensitive substring match). Must be specific — at least ${MIN_TRIGGER_PATTERN_LEN} characters, max ${MAX_TRIGGER_PATTERNS} patterns. Omit if this skill should only be reused explicitly via use_skill.` },
        steps:            { type: 'array', items: { type: 'string' }, description: `Ordered list of step-by-step instructions (max ${MAX_STEPS}). Provide this OR system_prompt.` },
        system_prompt:    { type: 'string', description: `Free-form instructions block, if steps[] is too rigid for this skill (max ${MAX_SYSTEM_PROMPT_LEN} chars). Provide this OR steps.` },
        environment_id:   { type: 'string', description: 'Environment to scope this skill to (optional — inferred from your linked environment if omitted). Must be an environment you are linked to.' },
      },
      required: ['name', 'description'],
    },
    tier: 'write',
    parallelSafe: false,
    availableIn: 'both',
    category: 'skills',
    handler: async (args, ctx) => {
      const { name, description, trigger_patterns, steps, system_prompt, environment_id } = args as {
        name?: string
        description?: string
        trigger_patterns?: string[]
        steps?: string[]
        system_prompt?: string
        environment_id?: string
      }
      if (!name || !description) return 'Error: save_skill requires name and description'

      const prompt = buildSkillPrompt(system_prompt, steps)
      if (!prompt) return 'Error: save_skill requires either steps[] or system_prompt'

      const contentError = validateSkillContent(trigger_patterns, prompt, steps)
      if (contentError) return `Error: ${contentError}`

      const envResult = await resolveEnvironmentId(ctx, environment_id)
      if (typeof envResult !== 'string') return `Error: ${envResult.error}`
      const envId = envResult

      const existing = await prisma.nebulaInstance.findUnique({
        where: { environmentId_name: { environmentId: envId, name } },
      })
      if (existing) return `A skill named "${name}" already exists in this environment (id: ${existing.id}). Choose a different name.`

      const spec: SkillSpec = {
        description,
        triggerPatterns: trigger_patterns ?? [],
        systemPrompt: prompt,
        steps: steps ?? undefined,
      }

      let created
      try {
        created = await prisma.nebulaInstance.create({
          data: {
            environmentId: envId,
            name,
            category: 'skill',
            spec: JSON.stringify(spec),
            isInstalled: true,
            source: 'agent',
            createdByAgentId: ctx.agentId ?? null,
          },
        })
      } catch (e: unknown) {
        // Race with a concurrent save of the same name — the pre-check above
        // doesn't fully close this window.
        if ((e as { code?: string })?.code === 'P2002') {
          return `A skill named "${name}" already exists in this environment (created concurrently). Choose a different name.`
        }
        throw e
      }

      const triggerNote = trigger_patterns?.length
        ? `It will auto-trigger in chat when a message contains one of its ${trigger_patterns.length} trigger phrase(s).`
        : 'It has no trigger phrases, so it will only be used when an agent explicitly calls use_skill.'
      return `Skill "${name}" saved (id: ${created.id}) and active immediately. ${triggerNote} Any agent linked to this environment can look it up with list_skills / use_skill.`
    },
  })

  registerTool({
    name: 'list_skills',
    description: 'List saved skills available in an environment, optionally filtered by a search term against name/description.',
    inputSchema: {
      type: 'object',
      properties: {
        environment_id: { type: 'string', description: 'Environment to list skills for (optional — inferred from your linked environment if omitted). Must be an environment you are linked to.' },
        query:          { type: 'string', description: 'Filter by substring match against skill name or description' },
      },
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'skills',
    handler: async (args, ctx) => {
      const { environment_id, query } = args as { environment_id?: string; query?: string }
      const envResult = await resolveEnvironmentId(ctx, environment_id)
      if (typeof envResult !== 'string') return `Error: ${envResult.error}`
      const envId = envResult

      const skills = await prisma.nebulaInstance.findMany({
        where: { environmentId: envId, category: 'skill', isInstalled: true },
        orderBy: { updatedAt: 'desc' },
      })

      const parsed = skills.map(s => {
        let spec: SkillSpec = {}
        try { spec = JSON.parse(s.spec) as SkillSpec } catch { /* malformed spec — omit details */ }
        return {
          id: s.id,
          name: s.name,
          description: spec.description ?? '',
          triggerPatterns: spec.triggerPatterns ?? [],
          source: s.source,
          createdByAgentId: s.createdByAgentId,
        }
      }).filter(s => {
        if (!query) return true
        const q = query.toLowerCase()
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      })

      if (parsed.length === 0) return 'No skills found.'
      return JSON.stringify(parsed)
    },
  })

  registerTool({
    name: 'use_skill',
    description: "Fetch a saved skill's full instructions by name or id so you can follow them. Use this when you recognize the current task matches a known skill (check list_skills first if unsure of the exact name).",
    inputSchema: {
      type: 'object',
      properties: {
        name:           { type: 'string', description: 'Skill name (exact match)' },
        skill_id:       { type: 'string', description: 'Skill id, if known — takes precedence over name' },
        environment_id: { type: 'string', description: 'Environment the skill belongs to (optional — inferred from your linked environment if omitted). Must be an environment you are linked to.' },
      },
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'skills',
    handler: async (args, ctx) => {
      const { name, skill_id, environment_id } = args as { name?: string; skill_id?: string; environment_id?: string }
      if (!name && !skill_id) return 'Error: use_skill requires name or skill_id'
      if (!ctx.agentId) return 'Error: no agent context — this tool requires an authenticated agent.'

      let instance
      if (skill_id) {
        instance = await prisma.nebulaInstance.findUnique({ where: { id: skill_id } })
        // skill_id bypasses the name-lookup env resolution below, so verify
        // the caller is actually linked to the skill's environment here —
        // otherwise any agent could read any skill in any environment by id.
        if (instance) {
          const link = await prisma.agentEnvironment.findFirst({
            where: { agentId: ctx.agentId, environmentId: instance.environmentId },
          })
          if (!link) return `Skill not found: ${skill_id}`
        }
      } else {
        const envResult = await resolveEnvironmentId(ctx, environment_id)
        if (typeof envResult !== 'string') return `Error: ${envResult.error}`
        instance = await prisma.nebulaInstance.findUnique({
          where: { environmentId_name: { environmentId: envResult, name: name! } },
        })
      }

      if (!instance || instance.category !== 'skill') return `Skill not found: ${name ?? skill_id}`
      if (!instance.isInstalled) return `Skill "${instance.name}" exists but is not installed/active.`

      let spec: SkillSpec = {}
      try { spec = JSON.parse(instance.spec) as SkillSpec } catch {
        return `Skill "${instance.name}" has a corrupted spec and cannot be used.`
      }

      await prisma.skillExecutionLog.create({
        data: {
          nebulaId: instance.id,
          source: 'manual',
          contextId: ctx.taskId ?? ctx.conversationId ?? ctx.roomId ?? null,
        },
      }).catch(() => { /* non-fatal — logging must not block skill use */ })

      const instructions = spec.systemPrompt || (spec.steps?.length ? spec.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '')
      if (!instructions) return `Skill "${instance.name}" has no instructions recorded.`

      return `=== SKILL: ${instance.name} ===\n${spec.description ? spec.description + '\n\n' : ''}${instructions}`
    },
  })
}
