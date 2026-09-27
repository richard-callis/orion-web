import { prisma } from '@/lib/db'
import { retrieveKnowledgeContext } from '@/lib/embeddings'
import { getPrompt } from '@/lib/system-prompts'
import { resolveAgentGateway } from '@/lib/agent-gateway'
import { getAgentsMd } from '@/lib/agents-md'
import { matchAndInjectSkills } from '@/lib/claude'
import { resolveAgentPrimaryEnvironmentId } from '@/lib/skill-tools'
import { releaseTaskClaim } from '@/workers/task-claim'
import { log, err } from '../log'
import { resolveModelId } from '../model'
import { buildScopedToolList } from '../tool-scope'
import type { PreparedTask, RunAccounting } from './types'

/**
 * Load the task and its agent and assemble the full system prompt (tool
 * preamble, agent prompt, AGENTS.md, matched skill, RAG context, plan gating).
 * Returns null — with the claim released — when the task can't run here.
 */
export async function buildTaskContext(taskId: string, acc: RunAccounting): Promise<PreparedTask | null> {
  // Load task with agent
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      agent: true,
      feature: { select: { id: true } },
    },
  })

  if (!task?.agent) {
    err(`Task ${taskId} has no agent — skipping`)
    await releaseTaskClaim(taskId)
    return null
  }

  const agent = task.agent
  acc.agentId = agent.id
  const meta = (agent.metadata ?? {}) as Record<string, unknown>

  if (meta.archived === true) {
    err(`Task ${taskId} assigned to archived agent "${agent.name}" — skipping`)
    await releaseTaskClaim(taskId)
    return null
  }

  const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
  const agentSystemPrompt = (meta.systemPrompt as string | undefined) ?? 'You are a helpful AI agent.'
  const modelId = await resolveModelId(contextConfig.llm)

  // Auto-inject task-relevant knowledge: semantic search on task title+description
  // surfaces the top-5 most relevant notes rather than injecting everything.
  const taskQuery = `${task.title}\n${task.description ?? ''}`
  const rawKnowledge = await retrieveKnowledgeContext(taskQuery, 5, 0.2).catch(() => '')
  const wikiContext = rawKnowledge
    ? `\n\n---\n## Relevant Knowledge Base Context\n${rawKnowledge}\n---\n\n`
    : ''

  // Resolve gateway from the agent's linked environment
  const agentGw = await resolveAgentGateway(agent.id)
  const gateway = agentGw ? { url: agentGw.url, token: agentGw.token } : null

  // Inject tool awareness preamble — lists all available tools at runtime
  // This is injected here (not in the agent's stored prompt) so it always reflects
  // the current tool set, not a stale snapshot from when the agent was created.
  const { lines: toolList, scoped: toolsScoped } = buildScopedToolList(
    `${task.title}\n${task.description ?? ''}`,
    !!gateway,
  )
  const toolListWithHint = toolsScoped
    ? `${toolList}\n\nAdditional context available via knowledge_load_context(query). Other tools exist beyond this scoped list — call knowledge_search or escalate if you need a capability not shown here.`
    : toolList
  const toolsPreamble = await getPrompt('system.task-runner-tools')
  // Replacer callback so `$&`, `$'` etc. in the tool list are inserted literally.
  const injectedPreamble = toolsPreamble.replace('{{toolList}}', () => toolListWithHint)

  // Fetch AGENTS.md from the environment's Gitea repo (if linked)
  const agentsMd = agentGw?.environmentId
    ? await getAgentsMd(agentGw.environmentId)
    : null
  const agentsMdSection = agentsMd
    ? `\n\n## Environment-Specific Instructions (from AGENTS.md)\n${agentsMd}`
    : ''

  // Auto-surface a matching saved skill (see skill-tools.ts) — this is the
  // same trigger-pattern match claude.ts uses for direct AI chat, so a task
  // whose title/description matches a skill's trigger phrase gets its
  // instructions injected automatically, not just when a human happens to
  // type the phrase in a chat conversation.
  const skillEnvId = await resolveAgentPrimaryEnvironmentId(agent.id)
  const skillMatch = skillEnvId
    ? await matchAndInjectSkills(skillEnvId, taskQuery, 'task_match', taskId).catch(() => ({ injected: '', skillName: null }))
    : { injected: '', skillName: null }
  const skillSection = skillMatch.injected
    ? `\n\n---\n## Matched Skill: ${skillMatch.skillName}\n${skillMatch.injected}\n---\n`
    : ''

  // Note: ORION snapshot + vector RAG are injected automatically by withContext()
  // inside createRunner() — no need to fetch them here.
  let systemPrompt = injectedPreamble + '\n\n' + agentSystemPrompt + agentsMdSection + skillSection + wikiContext

  // Plan-before-execute gating. If a previously-paused plan has been approved
  // (metadata.planApproved === true, set by /api/tasks/:id/resume-plan), skip
  // the planning phase entirely and execute the stored plan directly.
  const taskMeta = (task.metadata ?? {}) as Record<string, unknown>
  const planAlreadyApproved = taskMeta.planApproved === true
  const planBeforeExecute = contextConfig.planBeforeExecute === true && !planAlreadyApproved
  if (planBeforeExecute) {
    const planPrefix = await getPrompt('system.task-plan-prefix')
    systemPrompt = planPrefix + '\n\n' + systemPrompt
  } else if (planAlreadyApproved) {
    const blockedSteps = (taskMeta.blockedSteps as number[] | undefined) ?? []
    const planSteps = (taskMeta.planSteps as string[] | undefined) ?? []
    let approvedNote = '## Plan Approved\n\nYour plan for this task has been reviewed and approved by a human. ' +
      'Do NOT emit another <plan> block — proceed directly to executing the approved plan step by step.\n\n'
    if (blockedSteps.length > 0 && planSteps.length > 0) {
      const blockedDescriptions = blockedSteps
        .filter(i => i >= 0 && i < planSteps.length)
        .map(i => `  - Step ${i + 1}: ${planSteps[i]}`)
        .join('\n')
      approvedNote +=
        `**The following steps were BLOCKED by the approver and must NOT be executed:**\n${blockedDescriptions}\n\n` +
        'Skip these steps entirely and proceed with the remaining approved steps.\n\n'
    }
    systemPrompt = approvedNote + systemPrompt
  }

  log(`Starting task "${task.title}" (${taskId}) → agent "${agent.name}" [${modelId}]`)

  return { taskId, task, agent, taskMeta, modelId, systemPrompt, planBeforeExecute, agentGw, gateway }
}
