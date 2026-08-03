/**
 * Skill tools — let agents save, list, and use reusable step-by-step
 * procedures ("skills") on top of the existing NebulaInstance(category:'skill')
 * model that already powers automatic chat-trigger skill injection
 * (see matchAndInjectSkills in claude.ts).
 *
 * Skills are scoped per-environment, same as the Nebula UI's human-authored
 * skills. Agent-saved skills are auto-installed (no admin approval) since a
 * skill is just injected instructions — no code execution risk like a
 * proposed tool. Dream's skill-crafting phase (dream.ts) writes here too,
 * tagged source:'dream'.
 */

import { registerTool, type ToolExecutionContext } from '@/lib/tool-registry'
import { prisma } from '@/lib/db'

export interface SkillSpec {
  triggerPatterns?: string[]
  systemPrompt?: string
  steps?: string[]
  description?: string
}

/** Build the systemPrompt injected/returned for a skill from either explicit
 * instructions or an ordered step list. */
function buildSkillPrompt(systemPrompt: string | undefined, steps: string[] | undefined): string {
  if (systemPrompt?.trim()) return systemPrompt.trim()
  if (steps?.length) return steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return ''
}

async function resolveEnvironmentId(ctx: ToolExecutionContext, explicit?: string): Promise<string | null> {
  if (explicit) return explicit
  if (ctx.environmentId) return ctx.environmentId
  if (!ctx.agentId) return null
  const link = await prisma.agentEnvironment.findFirst({ where: { agentId: ctx.agentId } })
  return link?.environmentId ?? null
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
        trigger_patterns: { type: 'array', items: { type: 'string' }, description: 'Phrases that should auto-trigger this skill when they appear in a user message (case-insensitive substring match)' },
        steps:            { type: 'array', items: { type: 'string' }, description: 'Ordered list of step-by-step instructions. Provide this OR system_prompt.' },
        system_prompt:    { type: 'string', description: 'Free-form instructions block, if steps[] is too rigid for this skill. Provide this OR steps.' },
        environment_id:   { type: 'string', description: 'Environment to scope this skill to (optional — inferred from your linked environment if omitted)' },
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

      const envId = await resolveEnvironmentId(ctx, environment_id)
      if (!envId) return 'Error: no environment context — pass environment_id explicitly, or link this agent to an environment first'

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

      const created = await prisma.nebulaInstance.create({
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

      return `Skill "${name}" saved (id: ${created.id}). It's active immediately — it will auto-trigger on matching phrases in chat, and any agent can look it up with list_skills / use_skill.`
    },
  })

  registerTool({
    name: 'list_skills',
    description: 'List saved skills available in an environment, optionally filtered by a search term against name/description.',
    inputSchema: {
      type: 'object',
      properties: {
        environment_id: { type: 'string', description: 'Environment to list skills for (optional — inferred from your linked environment if omitted)' },
        query:          { type: 'string', description: 'Filter by substring match against skill name or description' },
      },
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'skills',
    handler: async (args, ctx) => {
      const { environment_id, query } = args as { environment_id?: string; query?: string }
      const envId = await resolveEnvironmentId(ctx, environment_id)
      if (!envId) return 'Error: no environment context — pass environment_id explicitly, or link this agent to an environment first'

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
        environment_id: { type: 'string', description: 'Environment the skill belongs to (optional — inferred from your linked environment if omitted)' },
      },
    },
    tier: 'read',
    parallelSafe: true,
    availableIn: 'both',
    category: 'skills',
    handler: async (args, ctx) => {
      const { name, skill_id, environment_id } = args as { name?: string; skill_id?: string; environment_id?: string }
      if (!name && !skill_id) return 'Error: use_skill requires name or skill_id'

      let instance
      if (skill_id) {
        instance = await prisma.nebulaInstance.findUnique({ where: { id: skill_id } })
      } else {
        const envId = await resolveEnvironmentId(ctx, environment_id)
        if (!envId) return 'Error: no environment context — pass environment_id explicitly, or link this agent to an environment first'
        instance = await prisma.nebulaInstance.findUnique({
          where: { environmentId_name: { environmentId: envId, name: name! } },
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
