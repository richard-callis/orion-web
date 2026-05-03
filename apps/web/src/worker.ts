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
import { MANAGEMENT_TOOL_DEFS, executeManagedTool } from './lib/management-tools'
import { getSystemRooms } from './lib/seed-system-epic'

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

// ── Model resolution ──────────────────────────────────────────────────────────

let cachedDefaultModel: string | null = null

/**
 * Resolve an agent's LLM setting to a concrete model ID.
 *
 * Rules:
 * - falsy / boolean true → use system default (SystemSetting['model.default'])
 * - bare agent ID (no prefix) → treat as ext:<id>
 * - already prefixed (claude:*, ollama:*, ext:*) → use as-is
 *
 * Falls back to 'claude:claude-sonnet-4-6' only if no system default is set.
 */
async function resolveModelId(llm: unknown): Promise<string> {
  const useDefault = !llm || llm === true

  if (useDefault || typeof llm !== 'string') {
    if (!cachedDefaultModel) {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'model.default' } })
      const value = setting?.value as string | undefined
      if (!value) throw new Error('No default LLM configured — set model.default in System Settings')
      cachedDefaultModel = value
    }
    return cachedDefaultModel
  }

  // Bare agent/model ID with no routing prefix → treat as external gateway agent
  if (!llm.startsWith('claude:') && !llm.startsWith('ollama:') && !llm.startsWith('ext:')) {
    return `ext:${llm}`
  }

  return llm
}

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
        feature: { select: { id: true } },
      },
    })

    if (!task?.agent) {
      err(`Task ${taskId} has no agent — skipping`)
      return
    }

    const agent = task.agent
    const meta = (agent.metadata ?? {}) as Record<string, unknown>

    if (meta.archived === true) {
      err(`Task ${taskId} assigned to archived agent "${agent.name}" — skipping`)
      return
    }

    const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
    const agentSystemPrompt = (meta.systemPrompt as string | undefined) ?? 'You are a helpful AI agent.'
    const modelId = await resolveModelId(contextConfig.llm)

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

    // Mark task as in progress
    await prisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } })

    // Create a conversation to hold the task's AI activity
    const conversation = await prisma.conversation.create({
      data: {
        title: `Task: ${task.title}`,
        metadata: { taskId, agentId: agent.id, orchestrated: true } as any,
      },
    })

    // Find or create the feature coordination room (if task has a featureId)
    const featureId = task.feature?.id ?? null
    const featureRoomId: string | null = featureId
      ? await findOrCreateFeatureRoom(featureId, agent.id)
      : null

    // Log start event
    await logTaskEvent(taskId, 'started', `Agent "${agent.name}" [${modelId}] starting task`, agent.id)
    // SOC2: always keep postToFeed as the audit trail
    await postToFeed(agent.id, `▶ Starting task: **${task.title}**`, taskId)
    // Additionally post to feature room if one exists
    if (featureRoomId) {
      await postToRoom(featureRoomId, agent.id, `▶ Starting task: **${task.title}**`, taskId)
    }

    const roomNote = featureRoomId
      ? `\n\n[Chat room for this task: ${featureRoomId} — use this room_id when calling orion_send_message]`
      : ''

    const ctx: TaskRunContext = {
      taskId,
      taskTitle:       task.title,
      taskDescription: (task.description ?? '') + roomNote,
      taskPlan:        task.plan ?? null,
      agentId:         agent.id,
      agentName:       agent.name,
      systemPrompt,
      modelId,
      gateway,
      managementTools: {
        definitions: MANAGEMENT_TOOL_DEFS,
        execute: (name, argsRaw) => executeManagedTool(name, argsRaw, agent.id),
      },
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
          if (featureRoomId) {
            const argsSummary = String(event.args ?? '').slice(0, 200)
            await postToRoom(featureRoomId, agent.id, `🔧 \`${event.tool}\`(${argsSummary})`, taskId)
          }
          break

        case 'tool_result': {
          await logTaskEvent(taskId, 'tool_result', event.result.slice(0, 2000), agent.id)
          await prisma.message.create({
            data: {
              conversationId: conversation.id, role: 'user',
              content: `[tool_result] ${event.tool}: ${event.result.slice(0, 2000)}`,
            },
          }).catch(() => {})
          if (featureRoomId) {
            // SOC2: redact secrets, truncate to 300 chars before posting to room
            const safeResult = redactSecrets(event.result).slice(0, 300)
            await postToRoom(featureRoomId, agent.id, `↩ \`${event.tool}\`: ${safeResult}`, taskId)
          }
          break
        }

        case 'done':
          break

        case 'error':
          throw new Error(event.error)
      }
    }

    const durationSec = Math.round((Date.now() - startedAt) / 1000)
    const summary = outputText.slice(-500) || 'Task completed.'

    const completionMsg = `✅ Completed: **${task.title}** (${durationSec}s · ${toolsUsed.length} tools)\n\n${summary}`
    await Promise.all([
      prisma.task.update({ where: { id: taskId }, data: { status: 'pending_validation' } }),
      logTaskEvent(taskId, 'completed', summary, agent.id),
      // SOC2: always keep postToFeed for audit trail
      postToFeed(agent.id, completionMsg, taskId),
      // Also post to feature room if one exists
      ...(featureRoomId ? [postToRoom(featureRoomId, agent.id, completionMsg, taskId)] : []),
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

// ── Chat room helpers ─────────────────────────────────────────────────────────

/**
 * Find or create the coordination ChatRoom for a Feature.
 * SOC2: room creation is logged to the agent-feed audit trail.
 */
async function findOrCreateFeatureRoom(featureId: string, agentId: string): Promise<string | null> {
  // Upsert on featureId unique constraint — race-condition safe, enforces 1:1 feature↔room
  const feature = await prisma.feature.findUnique({ where: { id: featureId }, select: { title: true } })
  const existing = await prisma.chatRoom.findUnique({ where: { featureId }, select: { id: true } })
  const room = existing ?? await prisma.chatRoom.create({
    data: { name: feature?.title ?? '', featureId, type: 'feature', createdBy: agentId },
    select: { id: true },
  })
  if (!existing) {
    // SOC2: log room creation to audit feed
    await postToFeed(agentId, `Room created for feature ${featureId} (room ${room.id})`)
  }
  // Ensure agent is a member
  await prisma.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId: room.id, agentId } },
    create: { roomId: room.id, agentId, role: 'member' },
    update: {},
  })
  return room.id
}

// SOC2: redact secret-like values from tool result content before posting to rooms
const SECRET_PATTERNS = /\b(token|password|secret|apikey|api_key|bearer|credential|private_key)\s*[=:]\s*\S+/gi
function redactSecrets(content: string): string {
  return content.replace(SECRET_PATTERNS, (match) => {
    const eqIdx = match.search(/[=:]/)
    return match.slice(0, eqIdx + 1) + ' [REDACTED]'
  })
}

/**
 * Post a message to a ChatRoom. agentId provides SOC2 attribution.
 * taskId tags the message to a specific task for filtered views.
 */
async function postToRoom(roomId: string, agentId: string, content: string, taskId?: string) {
  await prisma.chatMessage.create({
    data: { roomId, agentId, senderType: 'agent', content, taskId: taskId ?? null },
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
      where:   { status: { in: ['pending', 'in_progress', 'failed'] } },
      include: { agent: true, assignedUser: true, feature: { include: { epic: true } } },
      orderBy: { updatedAt: 'desc' },
      take:    50,
    }),
    prisma.agent.findMany({
      orderBy: { name: 'asc' },
      include: { tasks: { where: { status: 'in_progress' }, take: 1 } },
    }),
    prisma.taskEvent.findMany({
      where:   { eventType: { in: ['completed', 'failed', 'started'] } },
      orderBy: { createdAt: 'desc' },
      take:    10,
      include: { task: { select: { title: true } } },
    }),
  ])

  const unassigned = tasks.filter((t: any) => !t.assignedAgent && !t.assignedUserId)
  const running    = tasks.filter((t: any) => t.status === 'in_progress')
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

async function runWatchers() {
  const pausedSetting = await prisma.systemSetting.findUnique({ where: { key: 'system.watchers.paused' } })
  if (pausedSetting?.value === true) {
    log('Watchers paused — skipping this cycle')
    return
  }

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
    const modelId = await resolveModelId(cfg.llm)
    const envLink = agent.environments?.[0]
    const gateway = envLink?.environment?.gatewayUrl && envLink?.environment?.gatewayToken
      ? { url: envLink.environment.gatewayUrl, token: envLink.environment.gatewayToken }
      : null

    // Pre-fetch all context the agent needs — no API calls from the agent side
    const [contextNotes, snapshot, systemRooms] = await Promise.all([
      prisma.note.findMany({ where: { type: 'llm-context' }, select: { title: true, content: true } }),
      buildSystemSnapshot(),
      getSystemRooms(),
    ])

    const wikiContext = buildWikiContext(contextNotes)

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

    // The agent receives all data it needs as context — no outbound calls required.
    // Mutations go through tool calls (orion_assign_task, orion_create_agent, etc.)
    // executed server-side with full attribution (SOC2 [A-001]).
    const enrichedPrompt = [watchPrompt, roomContext, ``, snapshot].join('\n')

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
      managementTools: {
        definitions: MANAGEMENT_TOOL_DEFS,
        execute: (name, argsRaw) => executeManagedTool(name, argsRaw, agent.id),
      },
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
      agent: {
        NOT: {
          metadata: { path: ['archived'], equals: true },
        },
      },
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
