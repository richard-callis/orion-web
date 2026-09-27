import { prisma } from '@/lib/db'
import { createRunner } from '@/lib/agent-runner'
import type { TaskRunContext } from '@/lib/agent-runner'
import { retrieveKnowledgeContext } from '@/lib/embeddings'
import { MANAGEMENT_TOOL_DEFS, executeManagedTool } from '@/lib/management-tools'
import { getSystemRooms } from '@/lib/seed-system-epic'
import { getPrompt } from '@/lib/system-prompts'
import { resolveAgentGateway } from '@/lib/agent-gateway'
import { getAgentsMd } from '@/lib/agents-md'
import { log, err } from './log'
import { postToFeed } from './db-helpers'
import { resolveModelId } from './model'
import { managementToolLines } from './tool-scope'
import { MAX_NOTE_LENGTH, WATCHER_TIMEOUT_MS, runningWatchers } from './state'

/**
 * Build a snapshot of current system state (tasks, agents, recent events)
 * to inject into a watcher's prompt instead of having it call APIs itself.
 */
async function buildSystemSnapshot(): Promise<string> {
  const [tasks, agents, recentEvents] = await Promise.all([
    prisma.task.findMany({
      where:   { status: { in: ['pending', 'in_progress', 'failed'] } },
      include: { agent: true, assignedUser: true, feature: { include: { epic: true } } },
      orderBy: { updatedAt: 'desc' },
      take:    50,
    }),
    prisma.agent.findMany({
      orderBy: { name: 'asc' },
      include: { tasks: { where: { status: 'in_progress' }, take: 1 } },
      take: 200,
    }),
    prisma.taskEvent.findMany({
      where:   { eventType: { in: ['completed', 'failed', 'started'] } },
      orderBy: { createdAt: 'desc' },
      take:    10,
      include: { task: { select: { title: true } } },
    }),
  ])

  const unassigned = tasks.filter(t => !t.assignedAgent && !t.assignedUserId)
  const running    = tasks.filter(t => t.status === 'in_progress')
  const failed     = tasks.filter(t => t.status === 'failed')
  const pending    = tasks.filter(t => t.status === 'pending')

  const lines = [
    `## System Snapshot — ${new Date().toISOString()}`,
    ``,
    `### Tasks`,
    `- Pending: ${pending.length} (${unassigned.length} unassigned)`,
    `- Running: ${running.length}`,
    `- Failed:  ${failed.length}`,
    ``,
    `#### Unassigned pending tasks`,
    unassigned.length === 0
      ? '  (none)'
      : unassigned.map(t =>
          `  - [${t.id}] **${t.title}** (priority: ${t.priority})` +
          (t.feature ? ` — ${t.feature.epic?.title ?? ''} › ${t.feature.title}` : '') +
          (t.description ? `\n    ${t.description.slice(0, 120)}` : '')
        ).join('\n'),
    ``,
    `#### Running tasks`,
    running.length === 0
      ? '  (none)'
      : running.map(t => `  - [${t.id}] **${t.title}** → ${t.agent?.name ?? t.assignedUser?.name ?? '?'}`).join('\n'),
    ``,
    `#### Recently failed tasks`,
    failed.length === 0
      ? '  (none)'
      : failed.slice(0, 5).map(t => `  - [${t.id}] **${t.title}** → ${t.agent?.name ?? '?'}`).join('\n'),
    ``,
    `### Agents`,
    agents.map(a => {
      const busy = a.tasks.length > 0
      const meta = (a.metadata ?? {}) as Record<string, unknown>
      const cfg  = (meta.contextConfig ?? {}) as Record<string, unknown>
      const isPersistent = !!cfg.persistent
      return `  - [${a.id}] **${a.name}** (${a.type}) — ${a.role ?? 'no role'}` +
        (isPersistent ? ' [persistent]' : '') +
        (busy ? ' [BUSY]' : ' [available]') +
        (a.description ? `\n    ${a.description}` : '')
    }).join('\n'),
    ``,
    `### Recent activity`,
    recentEvents.length === 0
      ? '  (none)'
      : recentEvents.map(e => `  - ${e.eventType}: ${e.task?.title ?? e.taskId}`).join('\n'),
  ]

  return lines.join('\n')
}

// ── Watcher state persistence ───────────────────────────────────────────────────
// Notes have no agentId column, so watcher state is keyed by a deterministic
// title. type='watcher-state' keeps these out of the llm-context injection path.
function watcherStateTitle(agentId: string): string {
  return `watcher-state:${agentId}`
}

interface WatcherState {
  directives: string
  timestamp: number
  taskIds: string[]
}

async function loadWatcherState(agentId: string): Promise<WatcherState | null> {
  const note = await prisma.note
    .findFirst({ where: { type: 'watcher-state', title: watcherStateTitle(agentId) } })
    .catch(() => null)
  if (!note) return null
  try {
    return JSON.parse(note.content) as WatcherState
  } catch {
    return null
  }
}

async function saveWatcherState(agentId: string, state: WatcherState): Promise<void> {
  const title = watcherStateTitle(agentId)
  const content = JSON.stringify(state).slice(0, MAX_NOTE_LENGTH)
  const existing = await prisma.note
    .findFirst({ where: { type: 'watcher-state', title } })
    .catch(() => null)
  if (existing) {
    await prisma.note
      .update({ where: { id: existing.id }, data: { content, tags: ['last-directives'], updatedAt: new Date() } })
      .catch(() => {})
  } else {
    await prisma.note
      .create({ data: { title, content, folder: 'Watcher State', type: 'watcher-state', tags: ['last-directives'] } })
      .catch(() => {})
  }
}

/** Extract task IDs referenced in watcher output (e.g. "[abc123]") for loop-detection. */
function extractTaskIds(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[([a-z0-9]{20,})\]/gi)).map((m) => m[1])))
}

export async function runWatchers() {
  const pausedSetting = await prisma.systemSetting.findUnique({ where: { key: 'system.watchers.paused' } })
  // MINOR fix: SystemSetting.value is a string in the DB; comparing to boolean true never matched
  if (pausedSetting?.value === true || pausedSetting?.value === 'true') {
    log('Watchers paused — skipping this cycle')
    return
  }

  const watchers = await prisma.agent.findMany({
    where: { type: { not: 'human' } },
    take: 200,
  })

  for (const agent of watchers) {
    const meta = (agent.metadata ?? {}) as Record<string, unknown>
    const cfg  = (meta.contextConfig ?? {}) as Record<string, unknown>
    if (!cfg.persistent) continue

    const intervalMin = (cfg.watchIntervalMin as number | undefined) ?? 60
    const intervalMs  = intervalMin * 60 * 1000
    const lastRun     = (meta.watcherLastRun as number | undefined) ?? 0

    if (Date.now() - lastRun < intervalMs) continue

    const watchPrompt = (cfg.watchPrompt as string | undefined)
    if (!watchPrompt?.trim()) continue

    // Skip if this watcher is already running (poll interval < typical run time).
    if (runningWatchers.has(agent.id)) {
      log(`Skipping watcher "${agent.name}" — still running from previous cycle`)
      continue
    }

    log(`Running watcher: "${agent.name}"`)
    runningWatchers.add(agent.id)

    const systemPrompt = (meta.systemPrompt as string | undefined) ?? 'You are a monitoring agent.'
    const modelId = await resolveModelId(cfg.llm)
    const agentGw = await resolveAgentGateway(agent.id)
    const gateway = agentGw ? { url: agentGw.url, token: agentGw.token } : null

    // Pre-fetch all context the agent needs — no API calls from the agent side
    const [rawKnowledge, snapshot, systemRooms, prevState] = await Promise.all([
      retrieveKnowledgeContext((meta.systemPrompt as string | undefined) ?? agent.name, 5, 0.2).catch(() => ''),
      buildSystemSnapshot(),
      getSystemRooms(),
      loadWatcherState(agent.id),
    ])

    const wikiContext = rawKnowledge
      ? `\n\n---\n## Relevant Knowledge Base Context\n${rawKnowledge}\n---\n\n`
      : ''

    // Inject tool awareness preamble into watcher system prompt — same as task runner
    const watcherToolList = [
      ...managementToolLines(),
      ...(gateway ? ['- (gateway tools available: kubectl_get, shell_exec, and others connected via environment gateway)'] : []),
    ].join('\n')
    const watcherToolsPreamble = await getPrompt('system.task-runner-tools')
    const watcherInjectedPreamble = watcherToolsPreamble.replace('{{toolList}}', watcherToolList)

    // Fetch AGENTS.md from the environment's Gitea repo (if linked)
    const watcherAgentsMd = agentGw?.environmentId
      ? await getAgentsMd(agentGw.environmentId)
      : null
    const watcherAgentsMdSection = watcherAgentsMd
      ? `\n\n## Environment-Specific Instructions (from AGENTS.md)\n${watcherAgentsMd}`
      : ''

    const watcherSystemPrompt = watcherInjectedPreamble + '\n\n' + systemPrompt + watcherAgentsMdSection + wikiContext

    // Build system room context block so agents know where to post
    const roomLines = Object.entries({
      health:      systemRooms['system.room.health'],
      operations:  systemRooms['system.room.operations'],
      maintenance: systemRooms['system.room.maintenance'],
    })
      .filter(([, id]) => id !== null)
      .map(([name, id]) => `  ${name}: ${id}`)
    const roomContext = roomLines.length > 0
      ? `\n[System rooms — use these room_id values with orion_send_message]\n${roomLines.join('\n')}`
      : ''

    // Inject the previous run's directives so the watcher does not re-issue the
    // same assignments in a tight loop (prevents re-assignment churn).
    let priorDirectivesBlock = ''
    if (prevState && Date.now() - prevState.timestamp < 5 * 60 * 1000) {
      priorDirectivesBlock =
        `\n## Your previous directives (run ${new Date(prevState.timestamp).toISOString()})\n` +
        `${prevState.directives.slice(0, 2000)}\n` +
        (prevState.taskIds.length
          ? `Tasks you already acted on: ${prevState.taskIds.join(', ')}\n`
          : '') +
        `Do NOT re-issue directives for tasks you already assigned in the last 5 minutes unless their status has changed.\n`
    }

    // The agent receives all data it needs as context — no outbound calls required.
    // Mutations go through tool calls (orion_assign_task, orion_create_agent, etc.)
    // executed server-side with full attribution (SOC2 [A-001]).
    const enrichedPrompt = [watchPrompt, roomContext, priorDirectivesBlock, ``, snapshot].join('\n')

    const ctx: TaskRunContext = {
      taskId:          `watch:${agent.id}`,
      taskTitle:       `[Watch] ${agent.name}`,
      taskDescription: enrichedPrompt,
      taskPlan:        null,
      agentId:         agent.id,
      agentName:       agent.name,
      systemPrompt:    watcherSystemPrompt,
      modelId,
      gateway,
      environmentId:   agentGw?.environmentId,
      managementTools: {
        definitions: MANAGEMENT_TOOL_DEFS,
        execute: (name, argsRaw) => executeManagedTool(name, argsRaw, agent.id),
      },
      // Watchers have no task-level timeout of their own — cap each run.
      signal: AbortSignal.timeout(WATCHER_TIMEOUT_MS),
    }

    try {
      const runner = createRunner(modelId)
      let output = ''
      for await (const event of runner.run(ctx)) {
        if (event.type === 'text')  output += event.content
        if (event.type === 'error') throw new Error(event.error)
      }

      if (output.trim()) {
        await postToFeed(agent.id, `👁 **${agent.name}**:\n\n${output.trim().slice(0, 1500)}`)
      }

      // Persist this run's directives so the next run can avoid re-assignment loops.
      await saveWatcherState(agent.id, {
        directives: output.trim().slice(0, 4000),
        timestamp:  Date.now(),
        taskIds:    extractTaskIds(output),
      })
    } catch (e) {
      err(`Watcher "${agent.name}" failed: ${e}`)
      await postToFeed(agent.id, `❌ **${agent.name}** watcher error: ${e}`)
    } finally {
      // Always update lastRun (even on error) so a failing watcher respects
      // its interval instead of retrying every 60s until it succeeds.
      // BUG 6 fix: `agent.metadata` here is a snapshot from the START of this
      // watcher run, which can take minutes. Whole-object writing that stale
      // snapshot back would silently clobber any concurrent edit made during
      // the run (archiving, prompt change, etc). Re-fetch immediately before
      // the write and merge into THAT fresh copy to narrow the race window
      // from minutes to milliseconds.
      const freshAgent = await prisma.agent.findUnique({
        where: { id: agent.id },
        select: { metadata: true },
      }).catch(() => null)
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          metadata: {
            ...((freshAgent?.metadata ?? agent.metadata) as object ?? {}),
            watcherLastRun: Date.now()
          }
        }
      }).catch(() => { /* non-critical — next run will re-calculate from old lastRun */ })
      runningWatchers.delete(agent.id)
    }
  }
}
