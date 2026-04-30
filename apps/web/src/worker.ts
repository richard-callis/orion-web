/**
 * ORION Orchestrator — runs alongside the Next.js server.
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

// SOC2: [C-001] Maximum length per context note to prevent context overflow attacks
const MAX_NOTE_LENGTH = 8000

/**
 * Sanitize llm-context note content before injecting into system prompts (SOC2: [C-001]).
 *
 * Mitigates prompt injection attacks where a malicious user could inject
 * system-level instructions through note content (e.g., "Ignore previous instructions").
 *
 * Strategy:
 * - Strip known injection patterns
 * - Add clear boundary markers so LLMs distinguish data from instructions
 * - Truncate overly long notes
 * - Log warnings for suspicious content
 */
function sanitizeContextNote(title: string, content: string): string {
  // Known prompt injection patterns (case-insensitive)
  const INJECTION_PATTERNS = [
    /^\s*(ignore\s+(previous|above|prior)\s+(instructions|prompts|context|system))/im,
    /^\s*(you\s+are\s+now)/im,
    /^\s*(from\s+now\s+on)/im,
    /^\s*(override\s+(all|the)?\s*(system|previous|original)\s*(instructions|prompt|rules|behavior))/im,
    /^\s*(do\s+not\s+(follow|obey|respond))/im,
    /^\s*(disregard\s+(all|the)?\s*(instructions|previous|context))/im,
    /^\s*(begin\s+(new|all)\s*(instructions|system))/im,
    /^\s*(you\s+have\s+(been|been)?\s*(new|been))\s+role/im,
    /^\s*(change\s+(your|the)?\s*(role|persona|identity))/im,
    /^\s*(reveal|print|output|show|display|dump|list)\s+(your|the)?\s*(system|original|full|complete)\s*(prompt|instructions|rules|context)/im,
    /^\s*(show\s+me\s+(your|the|this))\s+(prompt|instructions|context)/im,
  ]

  // Check for injection patterns and warn
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      err(`[C-001] Potential prompt injection detected in note "${title}" — stripping suspicious lines`)
      // Strip the matching line
      content = content.split('\n')
        .filter((line: any) => !INJECTION_PATTERNS.some((p: any) => p.test(line)))
        .join('\n')
    }
  }

  // Truncate if too long
  if (content.length > MAX_NOTE_LENGTH) {
    content = content.slice(0, MAX_NOTE_LENGTH) + '\n\n[Note truncated — exceeded maximum length]'
    err(`[C-001] Context note "${title}" truncated to ${MAX_NOTE_LENGTH} chars`)
  }

  // Escape markdown that could break the prompt structure
  content = content.replace(/^---+$/, '---') // normalize horizontal rules

  return content
}

/**
 * Build sanitized knowledge base context from llm-context notes.
 * Returns a sanitized string to append to the system prompt.
 */
function buildWikiContext(notes: Array<{ title: string; content: string }>): string {
  if (notes.length === 0) return ''

  const sanitizedNotes = notes.map((n: any) => {
    const sanitizedContent = sanitizeContextNote(n.title, n.content)
    return `### ${n.title}\n${sanitizedContent}`
  }).join('\n\n---\n\n')

  return `\n\n---\n## Trusted Knowledge Base\n${sanitizedNotes}\n---\n## End Trusted Knowledge Base\n\n`
}

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

    // Inject llm-context wiki notes into every agent's system prompt (SOC2: [C-001])
    const contextNotes = await prisma.note.findMany({
      where: { type: 'llm-context' },
      orderBy: { updatedAt: 'desc' },
      select: { title: true, content: true },
    })
    const wikiContext = buildWikiContext(contextNotes)
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
        metadata: { taskId, agentId: agent.id, orchestrated: true } as any,
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
              metadata: { toolCall: { name: event.tool, args: event.args } } as any,
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

  const unassigned = tasks.filter((t: any) => !t.assignedAgent && !t.assignedUserId)
  const running    = tasks.filter((t: any) => t.status === 'running')
  const failed     = tasks.filter((t: any) => t.status === 'failed')
  const pending    = tasks.filter((t: any) => t.status === 'pending')

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
      : unassigned.map((t: any) =>
          `  - [${t.id}] **${t.title}** (priority: ${t.priority})` +
          (t.feature ? ` — ${t.feature.epic?.title ?? ''} › ${t.feature.title}` : '') +
          (t.description ? `\n    ${t.description.slice(0, 120)}` : '')
        ).join('\n'),
    ``,
    `#### Running tasks`,
    running.length === 0
      ? '  (none)'
      : running.map((t: any) => `  - [${t.id}] **${t.title}** → ${t.agent?.name ?? t.assignedUser?.name ?? '?'}`).join('\n'),
    ``,
    `#### Recently failed tasks`,
    failed.length === 0
      ? '  (none)'
      : failed.slice(0, 5).map((t: any) => `  - [${t.id}] **${t.title}** → ${t.agent?.name ?? '?'}`).join('\n'),
    ``,
    `### Agents`,
    agents.map((a: any) => {
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
      : recentEvents.map((e: any) => `  - ${e.eventType}: ${e.task?.title ?? e.taskId}`).join('\n'),
  ]

  return lines.join('\n')
}

// Mirrors the reserved-name check in POST /api/agents (kept in sync for SOC2 [INPUT-001])
const RESERVED_AGENT_NAMES = ['human', 'user', 'system', 'admin']

/**
 * Parse an agent's output for structured directives and execute them.
 *
 * Supported directives:
 *   assign       — assign pending tasks to agents (existing behaviour)
 *   create_agent — create a new agent (server-side, attributed to the watcher)
 *
 * Format: JSON block between ---DIRECTIVES--- and ---END---
 * { "assign": [{"taskId":"...","agentId":"..."}], "create_agent": {...}, "message": "..." }
 *
 * SOC2 [A-001]: all mutations go through the orchestrator, never via unauthenticated HTTP.
 * Every action is attributed to the watcher agent ID and written to AgentMessage (agent-feed).
 */
async function executeDirectives(agentId: string, output: string): Promise<void> {
  const match = output.match(/---DIRECTIVES---\s*([\s\S]*?)\s*---END---/)
  if (!match) return

  let directives: {
    assign?:       Array<{ taskId: string; agentId: string }>
    create_agent?: { name: string; type?: string; role?: string; description?: string; metadata?: Record<string, unknown> }
    message?:      string
  }
  try {
    directives = JSON.parse(match[1])
  } catch {
    err(`Failed to parse directives from agent output: ${match[1].slice(0, 200)}`)
    return
  }

  // ── assign ──────────────────────────────────────────────────────────────────
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

  // ── create_agent ─────────────────────────────────────────────────────────────
  // Equivalent to POST /api/agents but executed server-side with watcher attribution.
  // Applies the same reserved-name guard as the HTTP route (SOC2 [INPUT-001]).
  if (directives.create_agent) {
    const spec = directives.create_agent
    if (!spec.name?.trim()) {
      err(`create_agent directive from "${agentId}" is missing required "name"`)
    } else if (RESERVED_AGENT_NAMES.includes(spec.name.toLowerCase())) {
      err(`create_agent directive from "${agentId}": "${spec.name}" is a reserved name`)
      await postToFeed(agentId, `⚠️ Cannot create agent: **${spec.name}** is a reserved name`)
    } else {
      try {
        const created = await prisma.agent.create({
          data: {
            name:        spec.name.trim(),
            type:        spec.type ?? 'claude',
            role:        spec.role ?? null,
            description: spec.description ?? null,
            ...(spec.metadata && { metadata: spec.metadata as any }),
          },
        })
        log(`Orchestrator created agent "${created.name}" (${created.id}) directed by watcher "${agentId}"`)
        // SOC2 [A-001]: action attributed to the directing watcher in the agent-feed audit trail
        await postToFeed(agentId, `🤖 Created agent **${created.name}** (\`${created.id}\`) — ${created.role ?? 'no role'}`)
      } catch (e) {
        err(`Failed to execute create_agent directive from "${agentId}": ${e}`)
        await postToFeed(agentId, `❌ Failed to create agent **${spec.name}**: ${e}`)
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

    const wikiContext = buildWikiContext(contextNotes)

    // The agent receives all data it needs as context — no outbound calls required.
    // Writes go through the ---DIRECTIVES--- block; the orchestrator executes them
    // server-side with full attribution (SOC2 [A-001]).
    const enrichedPrompt = [
      watchPrompt,
      ``,
      snapshot,
      ``,
      `---`,
      `## Actions`,
      ``,
      `All data you need is in the snapshot above. Do NOT call the ORION API directly — there is no`,
      `authenticated HTTP client available to you. Use directives instead.`,
      ``,
      `To assign tasks or create agents, include ONE directives block at the end of your response:`,
      `\`\`\``,
      `---DIRECTIVES---`,
      `{`,
      `  "assign": [{"taskId":"<id>","agentId":"<id>"}],`,
      `  "create_agent": {`,
      `    "name": "<name>",`,
      `    "role": "<one-line role description>",`,
      `    "type": "claude",`,
      `    "description": "<optional longer description>",`,
      `    "metadata": {`,
      `      "systemPrompt": "<full system prompt for this agent>",`,
      `      "contextConfig": {"persistent": false}`,
      `    }`,
      `  },`,
      `  "message": "<brief reason for these actions>"`,
      `}`,
      `---END---`,
      `\`\`\``,
      ``,
      `Rules:`,
      `- Use "assign" to route pending tasks to available agents (IDs in snapshot).`,
      `- Use "create_agent" only when no existing agent is suitable for a task.`,
      `- Include only the keys you need — omit "assign" if making no assignments, omit "create_agent" if not creating an agent.`,
      `- Omit the directives block entirely if no action is needed.`,
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

// ── GitOps PR sync ─────────────────────────────────────────────────────────────

/**
 * Poll Gitea for the current state of any open GitOpsPRs and update the DB.
 * This is a fallback for when webhooks don't fire (e.g. Gitea delivery queue issues).
 * Runs every 60s — cheap since it only queries PRs that are still marked 'open'.
 */
async function syncGitOpsPRs() {
  const openPRs = await prisma.gitOpsPR.findMany({
    where: { status: 'open' },
    include: { environment: { select: { gitOwner: true, gitRepo: true } } },
  })

  if (openPRs.length === 0) return

  const { getGitProvider } = await import('./lib/git-provider')
  let provider: Awaited<ReturnType<typeof getGitProvider>>
  try {
    provider = await getGitProvider()
    if (!(await provider.isHealthy())) return
  } catch {
    return
  }

  for (const pr of openPRs) {
    const { gitOwner, gitRepo } = pr.environment
    if (!gitOwner || !gitRepo) continue

    try {
      // Fetch current PR state from git provider
      const remotePR = await provider.getPR(gitOwner, gitRepo, pr.prNumber)

      const merged = remotePR.merged
      const closed = remotePR.state === 'closed' || remotePR.state === 'merged'

      if (merged || closed) {
        await prisma.gitOpsPR.update({
          where: { id: pr.id },
          data: {
            status:   merged ? 'merged' : 'closed',
            mergedAt: merged ? new Date() : undefined,
          },
        })
        log(`GitOps sync: PR#${pr.prNumber} in ${gitOwner}/${gitRepo} → ${merged ? 'merged' : 'closed'}`)
      }
    } catch {
      // Non-fatal — individual PR fetch failures are skipped
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

  // GitOps PR sync — poll Gitea every 60s to catch merges missed by webhooks
  setInterval(() => {
    syncGitOpsPRs().catch(e => err(`GitOps PR sync failed: ${e}`))
  }, 60_000)
}

main().catch(e => { err(`Fatal: ${e}`); process.exit(1) })
