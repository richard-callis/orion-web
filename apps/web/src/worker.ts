/**
 * Mission Control Orchestrator — runs alongside the Next.js server.
 *
 * Polls for tasks assigned to AI agents and executes them using the
 * appropriate runner (Claude or Ollama), routing tool calls through the
 * environment's gateway.
 *
 * Started by entrypoint.sh as: node worker.js &
 */

import { prisma } from './lib/db'
import { createRunner } from './lib/agent-runner'
import type { TaskRunContext } from './lib/agent-runner'

const POLL_INTERVAL_MS = 15_000
const MAX_CONCURRENT   = 3

const runningTasks = new Set<string>()

// ── Logging helpers ────────────────────────────────────────────────────────────

function log(msg: string) { process.stdout.write(`[orchestrator] ${msg}\n`) }
function err(msg: string) { process.stderr.write(`[orchestrator] ERROR: ${msg}\n`) }

// ── Core task runner ───────────────────────────────────────────────────────────

async function runTask(taskId: string): Promise<void> {
  runningTasks.add(taskId)
  const startedAt = Date.now()

  try {
    // Load task with agent and environment
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        agent: {
          include: { environments: { include: { environment: true }, take: 1 } },
        },
      },
    })

    if (!task?.agent) {
      err(`Task ${taskId} has no agent — skipping`)
      return
    }

    const agent = task.agent
    const meta = (agent.metadata ?? {}) as Record<string, unknown>
    const contextConfig = (meta.contextConfig ?? {}) as Record<string, string>
    const agentSystemPrompt = (meta.systemPrompt as string | undefined) ?? 'You are a helpful AI agent.'
    const modelId = contextConfig.llm ?? 'claude:claude-sonnet-4-6'

    // Inject llm-context wiki notes into every agent's system prompt
    const contextNotes = await prisma.note.findMany({
      where: { type: 'llm-context' },
      orderBy: { updatedAt: 'desc' },
      select: { title: true, content: true },
    })
    const wikiContext = contextNotes.length > 0
      ? `\n\n---\n## Knowledge Base\n\n` + contextNotes.map(n => `### ${n.title}\n${n.content}`).join('\n\n')
      : ''
    const systemPrompt = agentSystemPrompt + wikiContext

    // Get the agent's first linked environment (if any)
    const envLink = agent.environments?.[0]
    const gateway = envLink?.environment?.gatewayUrl && envLink?.environment?.gatewayToken
      ? { url: envLink.environment.gatewayUrl, token: envLink.environment.gatewayToken }
      : null

    log(`Starting task "${task.title}" (${taskId}) → agent "${agent.name}" [${modelId}]`)

    // Mark task as running
    await prisma.task.update({ where: { id: taskId }, data: { status: 'running' } })

    // Create a conversation to hold the task's AI activity
    const conversation = await prisma.conversation.create({
      data: {
        title: `Task: ${task.title}`,
        metadata: { taskId, agentId: agent.id, orchestrated: true },
      },
    })

    // Log start event
    await logTaskEvent(taskId, 'started', `Agent "${agent.name}" [${modelId}] starting task`, agent.id)
    await postToFeed(agent.id, `▶ Starting task: **${task.title}**`, taskId)

    const ctx: TaskRunContext = {
      taskId,
      taskTitle:       task.title,
      taskDescription: task.description ?? null,
      taskPlan:        task.plan ?? null,
      agentId:         agent.id,
      agentName:       agent.name,
      systemPrompt,
      modelId,
      gateway,
    }

    const runner = createRunner(modelId)
    let outputText = ''
    let toolsUsed: string[] = []

    for await (const event of runner.run(ctx)) {
      switch (event.type) {
        case 'text':
          outputText += event.content
          // Store message in conversation
          await prisma.message.create({
            data: { conversationId: conversation.id, role: 'assistant', content: event.content },
          }).catch(() => {})
          break

        case 'tool_call':
          toolsUsed.push(event.tool)
          await logTaskEvent(taskId, 'tool_call', `🔧 ${event.tool}(${event.args})`, agent.id)
          await prisma.message.create({
            data: {
              conversationId: conversation.id, role: 'assistant',
              content: `[tool_call] ${event.tool}`,
              metadata: { toolCall: { name: event.tool, args: event.args } },
            },
          }).catch(() => {})
          break

        case 'tool_result':
          await logTaskEvent(taskId, 'tool_result', event.result.slice(0, 2000), agent.id)
          await prisma.message.create({
            data: {
              conversationId: conversation.id, role: 'user',
              content: `[tool_result] ${event.tool}: ${event.result.slice(0, 2000)}`,
            },
          }).catch(() => {})
          break

        case 'done':
          break

        case 'error':
          throw new Error(event.error)
      }
    }

    const durationSec = Math.round((Date.now() - startedAt) / 1000)
    const summary = outputText.slice(-500) || 'Task completed.'

    await Promise.all([
      prisma.task.update({ where: { id: taskId }, data: { status: 'done' } }),
      logTaskEvent(taskId, 'completed', summary, agent.id),
      postToFeed(agent.id, `✅ Completed: **${task.title}** (${durationSec}s · ${toolsUsed.length} tools)\n\n${summary}`, taskId),
      prisma.claudeInvocation.create({
        data: {
          conversationId: conversation.id,
          prompt:   task.title,
          toolsUsed,
          durationMs: Date.now() - startedAt,
          success: true,
        },
      }).catch(() => {}),
    ])

    log(`Completed task "${task.title}" (${taskId}) in ${durationSec}s`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(`Task ${taskId} failed: ${msg}`)

    const failedTask = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, assignedAgent: true } }).catch(() => null)
    await Promise.all([
      prisma.task.update({ where: { id: taskId }, data: { status: 'failed' } }).catch(() => {}),
      logTaskEvent(taskId, 'failed', msg, failedTask?.assignedAgent ?? undefined),
    ])
    if (failedTask?.assignedAgent) {
      await postToFeed(failedTask.assignedAgent, `❌ Failed: **${failedTask.title}**\n\n${msg}`, taskId).catch(() => {})
    }
  } finally {
    runningTasks.delete(taskId)
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function logTaskEvent(taskId: string, eventType: string, content: string, agentId?: string) {
  await prisma.taskEvent.create({ data: { taskId, eventType, content, agentId: agentId ?? null } }).catch(() => {})
}

async function postToFeed(agentId: string, content: string, taskId?: string) {
  await prisma.agentMessage.create({
    data: {
      agentId,
      channel:     'agent-feed',
      content,
      messageType: 'task_update',
      threadId:    taskId,
    },
  }).catch(() => {})
}

// ── Persistent watcher loop ────────────────────────────────────────────────────

// Track last-run time per watcher agent
const watcherLastRun = new Map<string, number>()

/**
 * Build a snapshot of current system state (tasks, agents, recent events)
 * to inject into a watcher's prompt instead of having it call APIs itself.
 */
async function buildSystemSnapshot(): Promise<string> {
  const [tasks, agents, recentEvents] = await Promise.all([
    prisma.task.findMany({
      where:   { status: { in: ['pending', 'running', 'failed'] } },
      include: { agent: true, assignedUser: true, feature: { include: { epic: true } } },
      orderBy: { updatedAt: 'desc' },
      take:    50,
    }),
    prisma.agent.findMany({
      orderBy: { name: 'asc' },
      include: { tasks: { where: { status: 'running' }, take: 1 } },
    }),
    prisma.taskEvent.findMany({
      where:   { eventType: { in: ['completed', 'failed', 'started'] } },
      orderBy: { createdAt: 'desc' },
      take:    10,
      include: { task: { select: { title: true } } },
    }),
  ])

  const unassigned = tasks.filter(t => !t.assignedAgent && !t.assignedUserId)
  const running    = tasks.filter(t => t.status === 'running')
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
        (busy ? ' [BUSY]' : ' [available]')
    }).join('\n'),
    ``,
    `### Recent activity`,
    recentEvents.length === 0
      ? '  (none)'
      : recentEvents.map(e => `  - ${e.eventType}: ${e.task?.title ?? e.taskId}`).join('\n'),
  ]

  return lines.join('\n')
}

/**
 * Parse an agent's output for structured directives and execute them.
 * Format the agent outputs between ---DIRECTIVES--- and ---END--- as JSON:
 * { "assign": [{"taskId":"...","agentId":"..."}], "message": "..." }
 */
async function executeDirectives(agentId: string, output: string): Promise<void> {
  const match = output.match(/---DIRECTIVES---\s*([\s\S]*?)\s*---END---/)
  if (!match) return

  let directives: { assign?: Array<{ taskId: string; agentId: string }>; message?: string }
  try {
    directives = JSON.parse(match[1])
  } catch {
    err(`Failed to parse directives from agent output: ${match[1].slice(0, 200)}`)
    return
  }

  if (directives.assign?.length) {
    for (const { taskId, agentId: targetAgentId } of directives.assign) {
      try {
        await prisma.task.update({
          where: { id: taskId },
          data:  { assignedAgent: targetAgentId, status: 'pending' },
        })
        const [task, agent] = await Promise.all([
          prisma.task.findUnique({ where: { id: taskId }, select: { title: true } }),
          prisma.agent.findUnique({ where: { id: targetAgentId }, select: { name: true } }),
        ])
        log(`Orchestrator assigned "${task?.title}" → "${agent?.name}"`)
        await postToFeed(agentId, `📋 Assigned **${task?.title}** → **${agent?.name}**`)
      } catch (e) {
        err(`Failed to execute assignment ${taskId} → ${targetAgentId}: ${e}`)
      }
    }
  }
}

async function runWatchers() {
  const watchers = await prisma.agent.findMany({
    where:   { type: { not: 'human' } },
    include: { environments: { include: { environment: true }, take: 1 } },
  })

  for (const agent of watchers) {
    const meta = (agent.metadata ?? {}) as Record<string, unknown>
    const cfg  = (meta.contextConfig ?? {}) as Record<string, unknown>
    if (!cfg.persistent) continue

    const intervalMin = (cfg.watchIntervalMin as number | undefined) ?? 60
    const intervalMs  = intervalMin * 60 * 1000
    const lastRun     = watcherLastRun.get(agent.id) ?? 0

    if (Date.now() - lastRun < intervalMs) continue
    watcherLastRun.set(agent.id, Date.now())

    const watchPrompt = (cfg.watchPrompt as string | undefined)
    if (!watchPrompt?.trim()) continue

    log(`Running watcher: "${agent.name}"`)

    const systemPrompt = (meta.systemPrompt as string | undefined) ?? 'You are a monitoring agent.'
    const modelId = (cfg.llm as string | undefined) ?? 'claude:claude-sonnet-4-6'
    const envLink = agent.environments?.[0]
    const gateway = envLink?.environment?.gatewayUrl && envLink?.environment?.gatewayToken
      ? { url: envLink.environment.gatewayUrl, token: envLink.environment.gatewayToken }
      : null

    // Pre-fetch all context the agent needs — no API calls from the agent side
    const [contextNotes, snapshot] = await Promise.all([
      prisma.note.findMany({ where: { type: 'llm-context' }, select: { title: true, content: true } }),
      buildSystemSnapshot(),
    ])

    const wikiContext = contextNotes.length > 0
      ? '\n\n---\n## Knowledge Base\n\n' + contextNotes.map(n => `### ${n.title}\n${n.content}`).join('\n\n')
      : ''

    // The agent receives all data it needs as context — no outbound calls required.
    // If it wants to assign tasks, it outputs a ---DIRECTIVES--- JSON block.
    const enrichedPrompt = [
      watchPrompt,
      ``,
      snapshot,
      ``,
      `---`,
      `To assign tasks, include a directives block at the end of your response:`,
      `\`\`\``,
      `---DIRECTIVES---`,
      `{"assign":[{"taskId":"<id>","agentId":"<id>"}],"message":"reason"}`,
      `---END---`,
      `\`\`\``,
      `Only include the directives block if you are making assignments. Task and agent IDs are shown in the snapshot above.`,
    ].join('\n')

    const ctx: TaskRunContext = {
      taskId:          `watch:${agent.id}`,
      taskTitle:       `[Watch] ${agent.name}`,
      taskDescription: enrichedPrompt,
      taskPlan:        null,
      agentId:         agent.id,
      agentName:       agent.name,
      systemPrompt:    systemPrompt + wikiContext,
      modelId,
      gateway,
    }

    try {
      const runner = createRunner(modelId)
      let output = ''
      for await (const event of runner.run(ctx)) {
        if (event.type === 'text')  output += event.content
        if (event.type === 'error') throw new Error(event.error)
      }

      // Execute any directives (task assignments, etc.)
      await executeDirectives(agent.id, output)

      // Strip directives block before posting to feed
      const feedOutput = output.replace(/---DIRECTIVES---[\s\S]*?---END---/g, '').trim()
      if (feedOutput) {
        await postToFeed(agent.id, `👁 **${agent.name}**:\n\n${feedOutput.slice(0, 1500)}`)
      }
    } catch (e) {
      err(`Watcher "${agent.name}" failed: ${e}`)
      await postToFeed(agent.id, `❌ **${agent.name}** watcher error: ${e}`)
    }
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

async function pollOnce() {
  if (runningTasks.size >= MAX_CONCURRENT) return

  const available = MAX_CONCURRENT - runningTasks.size
  const tasks = await prisma.task.findMany({
    where: {
      status:        'pending',
      assignedAgent: { not: null },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: available,
    select: { id: true },
  })

  for (const { id } of tasks) {
    if (!runningTasks.has(id)) {
      runTask(id).catch(e => err(`Unhandled error in runTask(${id}): ${e}`))
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

async function main() {
  log('Orchestrator starting…')

  // Wait for the DB to be ready (give Next.js time to run prisma db push)
  await new Promise(resolve => setTimeout(resolve, 5_000))

  log(`Polling every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_CONCURRENT} concurrent tasks`)

  // Initial poll
  await pollOnce().catch(e => err(`Initial poll failed: ${e}`))

  // Ongoing poll for assigned tasks
  setInterval(() => {
    pollOnce().catch(e => err(`Poll failed: ${e}`))
  }, POLL_INTERVAL_MS)

  // Watcher poll — check every minute whether any watcher is due
  setInterval(() => {
    runWatchers().catch(e => err(`Watcher poll failed: ${e}`))
  }, 60_000)
}

main().catch(e => { err(`Fatal: ${e}`); process.exit(1) })
