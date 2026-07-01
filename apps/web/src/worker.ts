/**
 * ORION Orchestrator — runs alongside the Next.js server.
 *
 * Polls for tasks assigned to AI agents and executes them using the
 * appropriate runner (Claude or Ollama), routing tool calls through the
 * environment's gateway.
 *
 * Started by entrypoint.sh as: node worker.js &
 */

import { createHash } from 'crypto'
import { prisma } from './lib/db'
import { notify } from './lib/notifications'
import { createRunner } from './lib/agent-runner'
import type { TaskRunContext } from './lib/agent-runner'
import { retrieveKnowledgeContext } from './lib/embeddings'
import { MANAGEMENT_TOOL_DEFS, executeManagedTool } from './lib/management-tools'
import { getSystemRooms } from './lib/seed-system-epic'
import { getPrompt } from './lib/system-prompts'
import { resolveAgentGateway } from './lib/agent-gateway'
import { getAgentsMd } from './lib/agents-md'
import { startDream } from './lib/dream'
import { createTrace } from './lib/langfuse'
import {
  checkAgentBudget,
  recordTokenUsage,
  acquireBudgetLock,
  releaseBudgetLock,
} from './lib/token-budget'
import { runCorrelator } from './workers/security-correlator'
import { runK8sPollerAll } from './jobs/security-poll-k8s'
import { runElkPollerAll } from './jobs/security-poll-elk'
import { runNtopngPollerAll } from './jobs/security-poll-ntopng'
import { runDailyScan, runEventTriggeredScan } from './jobs/security-scan-vulns'
import { runGoalHeartbeat } from './jobs/goal-heartbeat'
import { redactSecrets } from './lib/redact'
import { detectGitOpsDrift } from './jobs/gitops-drift'
import { runScheduler } from './jobs/task-scheduler'
import { syncCrowdSecDecisions } from './lib/security/crowdsec-bouncer'
import { shouldFederate, dispatchToSpoke } from './lib/federation'

// Configurable via SystemSetting — worker.pollIntervalMs and worker.maxConcurrent
// so operators can tune throughput without redeploying.
let POLL_INTERVAL_MS = 15_000
let MAX_CONCURRENT   = 3

// SOC2: [C-001] Maximum length per context note to prevent context overflow attacks
const MAX_NOTE_LENGTH = 8000

/**
 * Sanitize llm-context note content before injecting into system prompts (SOC2: [C-001]).
 * Also exported via lib/sanitize-context.ts for use in the vector-search retrieval path.
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
  content = content.replace(/^---+$/gm, '---') // normalize horizontal rules

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

// ── Role-aware tool grouping ────────────────────────────────────────────────────
// Instead of injecting the full flat tool inventory on every task, detect the task
// type from its title/description and inject only the relevant groups plus core
// always-available tools. Falls back to the full inventory when no type matches.
const TOOL_GROUPS: Record<string, string[]> = {
  deployment:    ['gitops_propose', 'gitops_ls', 'gitea_merge_pr', 'validate_manifest', 'orion_cluster_health', 'get_deployment_template', 'list_deployment_templates'],
  investigation: ['knowledge_search', 'orion_get_environment', 'spawn_agent'],
  incident:      ['security_propose_action', 'observable_add', 'observable_set_verdict', 'investigation_create', 'investigation_update'],
  coordination:  ['orion_create_task', 'orion_assign_task', 'orion_escalate_task', 'orion_close_task', 'spawn_agent'],
  knowledge:     ['knowledge_remember', 'knowledge_search', 'knowledge_write', 'knowledge_graph', 'knowledge_load_context'],
}

// Tools that are always available regardless of detected task type.
const CORE_TOOLS = ['knowledge_search', 'knowledge_load_context', 'spawn_agent', 'orion_escalate_task']

// Keyword → group detection. First matching group(s) win; multiple can match.
const TASK_TYPE_KEYWORDS: Record<string, RegExp> = {
  deployment:    /\b(deploy|rollout|release|manifest|helm|gitops|image tag|argocd|sync)\b/i,
  incident:      /\b(incident|breach|alert|attack|intrusion|malware|cve|vulnerab|ban|firewall|observable|investigation)\b/i,
  investigation: /\b(investigate|diagnose|debug|root cause|why is|triage|inspect|analyze)\b/i,
  coordination:  /\b(assign|delegate|coordinate|schedule|create task|escalate|backlog|prioriti)\b/i,
  knowledge:     /\b(document|knowledge|runbook|wiki|note|remember|lesson)\b/i,
}

/**
 * Build the tool-inventory preamble lines for a task, scoped to the detected task
 * type(s). Returns the full inventory when nothing matches (preserves prior
 * behaviour). The flag indicates whether scoping was applied (so a hint about
 * knowledge_load_context can be added to the preamble).
 */
function buildScopedToolList(
  taskText: string,
  gatewayAvailable: boolean,
): { lines: string; scoped: boolean } {
  const matched = Object.entries(TASK_TYPE_KEYWORDS)
    .filter(([, re]) => re.test(taskText))
    .map(([group]) => group)

  const gatewayLine = gatewayAvailable
    ? ['- (gateway tools available: kubectl_get, shell_exec, and others connected via environment gateway)']
    : []

  if (matched.length === 0) {
    // Fallback: full flat inventory (previous behaviour).
    return {
      lines: [
        ...MANAGEMENT_TOOL_DEFS.map((t: any) => `- ${t.name}: ${t.description.split('\n')[0]}`),
        ...gatewayLine,
      ].join('\n'),
      scoped: false,
    }
  }

  const allowed = new Set<string>([...CORE_TOOLS])
  for (const group of matched) for (const name of TOOL_GROUPS[group] ?? []) allowed.add(name)

  const lines = [
    ...MANAGEMENT_TOOL_DEFS
      .filter((t: any) => allowed.has(t.name))
      .map((t: any) => `- ${t.name}: ${t.description.split('\n')[0]}`),
    ...gatewayLine,
  ].join('\n')

  return { lines, scoped: true }
}

const runningTasks = new Set<string>()
// Guards against concurrent watcher runs: the 60s poll interval is shorter
// than many watcher runtimes, so without this a slow watcher would launch
// multiple parallel copies that each issue duplicate mutating tool calls.
const runningWatchers = new Set<string>()

// Overlap guards for periodic jobs — prevents a slow run stacking on itself
// (e.g. a 15s ELK poll that takes >15s produces competing cursor updates).
let runningGitOpsSync = false
let runningCorrelator = false
let runningK8sPoller = false
let runningElkPoller = false
let runningNtopngPoller = false
let runningVulnScan = false
let runningDriftDetector = false
let runningScheduler = false
let runningFedPoller = false

const TASK_TIMEOUT_MS = 60 * 60 * 1000 // 60 minutes

function isTransientError(errorMessage: string): boolean {
  const transientPatterns = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
    'rate_limit', '429', '503', '502',
    'timeout', 'Gateway timeout', 'upstream connect error',
    'Connection reset', 'socket hang up'
  ]
  return transientPatterns.some(p => errorMessage.toLowerCase().includes(p.toLowerCase()))
}

async function recoverStuckTasks() {
  // Allow overriding the 30-min default via SystemSetting (minutes)
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'worker.stuckTaskMinutes' } }).catch(() => null)
  const stuckMinutes = Math.max(10, parseInt(String(setting?.value ?? '30'), 10) || 30)
  const stuckCutoff = new Date(Date.now() - stuckMinutes * 60 * 1000)
  const stuck = await prisma.task.findMany({
    where: { status: 'in_progress', updatedAt: { lt: stuckCutoff } }
  })
  for (const task of stuck) {
    // Don't fail tasks that have a pending retry scheduled in the future
    if (task.nextRetryAt && task.nextRetryAt > new Date()) {
      console.log(`[recovery] Skipping task ${task.id} — retry scheduled at ${task.nextRetryAt.toISOString()}`)
      continue
    }
    const retries = ((task.metadata as any)?.recoveryCount ?? 0) as number
    const MAX_RECOVERY = 2
    const newStatus = retries < MAX_RECOVERY ? 'open' : 'failed'
    const newMeta = { ...(task.metadata as object ?? {}), recoveryCount: retries + 1 }
    await prisma.task.update({
      where: { id: task.id },
      data: { status: newStatus, assignedAgent: newStatus === 'open' ? task.assignedAgent : null, metadata: newMeta as any }
    })
    await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        eventType: 'system',
        content: newStatus === 'open'
          ? `Task re-queued after crashed worker (${stuckMinutes}min inactivity). Recovery attempt ${retries + 1}/${MAX_RECOVERY}.`
          : `Task failed after ${MAX_RECOVERY} recovery attempts. Use orion_reopen_task to retry manually.`,
        agentId: null
      }
    })
    console.log(`[recovery] Recovered stuck task ${task.id} — ${newStatus} (attempt ${retries + 1}, threshold ${stuckMinutes}min)`)
  }
  if (stuck.length > 0) console.log(`[recovery] Recovered ${stuck.length} stuck task(s)`)
}

// ── Logging helpers ────────────────────────────────────────────────────────────

function log(msg: string) { process.stdout.write(`[orchestrator] ${msg}\n`) }
function err(msg: string) { process.stderr.write(`[orchestrator] ERROR: ${msg}\n`) }

// ── Model resolution ──────────────────────────────────────────────────────────

let cachedDefaultModel: string | null = null
let cachedDefaultModelAt = 0
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000 // re-read from DB every 5 minutes

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
    if (!cachedDefaultModel || Date.now() - cachedDefaultModelAt > MODEL_CACHE_TTL_MS) {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'model.default' } })
      const value = setting?.value as string | undefined
      if (!value) throw new Error('No default LLM configured — set model.default in System Settings')
      cachedDefaultModel = value
      cachedDefaultModelAt = Date.now()
    }
    return cachedDefaultModel
  }

  // Bare agent/model ID with no routing prefix → treat as external gateway agent
  if (!llm.startsWith('claude:') && !llm.startsWith('ollama:') && !llm.startsWith('ext:')) {
    return `ext:${llm}`
  }

  return llm
}

// ── Reviewer agent ────────────────────────────────────────────────────────────

/**
 * Optionally spawns a lightweight reviewer agent after a task completes to
 * validate output quality. If the reviewer rejects the output, the task is
 * reopened to `pending` so it gets retried.
 *
 * Reviewer failures are non-fatal — any error is logged and ignored so the
 * task outcome is never affected.
 */
async function runReviewerCheck(
  taskId: string,
  taskTitle: string,
  output: string,
  agentId: string,
  modelId: string,
): Promise<void> {
  if (output.trim().length === 0) return

  try {
    await logTaskEvent(taskId, 'reviewer_start', 'Reviewer agent checking output quality', agentId)

    const reviewerSystemPrompt =
      'You are a quality reviewer for AI agent task outputs. Your ONLY job is to check if the task output is complete and sensible. Reply with exactly one of:\n' +
      '- APPROVED: <one-line reason>\n' +
      '- REJECTED: <one-line reason explaining what is missing or wrong>\n' +
      'Do not add any other text.'

    const ctx: TaskRunContext = {
      taskId,
      taskTitle,
      taskDescription: `Task: ${taskTitle}\n\nOutput to review:\n${output.slice(0, 3000)}`,
      taskPlan:        null,
      agentId,
      agentName:       'reviewer',
      systemPrompt:    reviewerSystemPrompt,
      modelId,
      gateway:         null,
    }

    const runner = createRunner(modelId)
    let reviewText = ''

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Reviewer timed out after 60s')), 60_000)
    )

    const runReview = async () => {
      for await (const event of runner.run(ctx)) {
        if (event.type === 'text') reviewText += event.content
        if (event.type === 'error') throw new Error(event.error)
      }
    }

    await Promise.race([runReview(), timeout])

    const verdict = reviewText.trim()
    if (verdict.startsWith('REJECTED:')) {
      const reason = verdict.slice('REJECTED:'.length).trim()
      await logTaskEvent(taskId, 'reviewer_rejected', reason, agentId)
      const current = await prisma.task.findUnique({ where: { id: taskId }, select: { retryCount: true } })
      const retryCount = (current?.retryCount ?? 0) + 1
      // Cap retries at 3 to prevent unbounded rejection loops
      const newStatus = retryCount >= 3 ? 'failed' : 'pending'
      await prisma.task.update({ where: { id: taskId }, data: { status: newStatus, retryCount } })
    } else {
      const reason = verdict.startsWith('APPROVED:') ? verdict.slice('APPROVED:'.length).trim() : verdict
      await logTaskEvent(taskId, 'reviewer_approved', reason || 'Output approved', agentId)
    }
  } catch (e) {
    err(`runReviewerCheck for task ${taskId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Core task runner ───────────────────────────────────────────────────────────

async function runTask(taskId: string): Promise<void> {
  runningTasks.add(taskId)
  const startedAt = Date.now()

  const taskAbort = new AbortController()
  const timeoutHandle = setTimeout(() => {
    taskAbort.abort()
    console.log(`[timeout] Task ${taskId} exceeded ${TASK_TIMEOUT_MS / 60000} minutes — aborting`)
  }, TASK_TIMEOUT_MS)

  let trace: ReturnType<typeof createTrace> | null = null
  let mainSpan: string | null = null

  try {
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
    const injectedPreamble = toolsPreamble.replace('{{toolList}}', toolListWithHint)

    // Fetch AGENTS.md from the environment's Gitea repo (if linked)
    const agentsMd = agentGw?.environmentId
      ? await getAgentsMd(agentGw.environmentId)
      : null
    const agentsMdSection = agentsMd
      ? `\n\n## Environment-Specific Instructions (from AGENTS.md)\n${agentsMd}`
      : ''

    // Note: ORION snapshot + vector RAG are injected automatically by withContext()
    // inside createRunner() — no need to fetch them here.
    let systemPrompt = injectedPreamble + '\n\n' + agentSystemPrompt + agentsMdSection + wikiContext

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

    // ── Budget gate ────────────────────────────────────────────────────────────
    // SOC2: [H-TOCTOU] Acquire per-agent mutex before reading usage to prevent
    // concurrent tasks all seeing the same stale usage total before any records.
    const budgetLockToken = await acquireBudgetLock(agent.id)
    if (budgetLockToken === null) {
      // Another task holds the budget lock for this agent — re-queue and retry later.
      await prisma.task.update({ where: { id: taskId }, data: { status: 'pending' } })
      log(`Task "${task.title}" (${taskId}) deferred — budget lock held by another task`)
      return
    }
    let budgetCheck: { allowed: boolean; reason?: string }
    try {
      budgetCheck = await checkAgentBudget(agent.id)
    } finally {
      await releaseBudgetLock(agent.id, budgetLockToken)
    }
    if (!budgetCheck.allowed) {
      const budgetMsg = `Budget gate: ${budgetCheck.reason} — task paused until budget resets or limit is increased.`
      await Promise.all([
        prisma.task.update({
          where: { id: taskId },
          data: {
            status: 'pending_validation',
            metadata: { ...taskMeta, budgetExceeded: true, budgetReason: budgetCheck.reason } as object,
          },
        }),
        logTaskEvent(taskId, 'budget_gate', budgetMsg, agent.id),
        postToFeed(agent.id, `⛔ ${budgetMsg}`, taskId),
      ])
      log(`Task "${task.title}" (${taskId}) paused — ${budgetCheck.reason}`)
      return
    }

    // ── Federation check ──────────────────────────────────────────────────────
    try {
      const fed = await shouldFederate(taskId)
      if (fed.federate && fed.spokeUrl && fed.token) {
        const dispatched = await dispatchToSpoke(taskId, fed.spokeUrl, fed.token)
        if (dispatched) {
          await prisma.task.update({
            where: { id: taskId },
            data: {
              metadata: {
                ...(taskMeta as object),
                federated: true,
                spokeUrl: fed.spokeUrl,
              } as object,
            },
          })
          await logTaskEvent(taskId, 'federated',
            `Task dispatched to spoke at ${fed.spokeUrl} for execution`, agent.id)
          log(`Task "${task.title}" (${taskId}) federated to spoke ${fed.spokeUrl}`)
          return
        }
        log(`Federation dispatch for task ${taskId} to ${fed.spokeUrl} failed — running locally`)
      }
    } catch (fedErr) {
      err(`Federation check for task ${taskId} failed (non-fatal): ${fedErr instanceof Error ? fedErr.message : String(fedErr)}`)
    }
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
      environmentId:   agentGw?.environmentId,
      managementTools: {
        definitions: MANAGEMENT_TOOL_DEFS,
        execute: (name, argsRaw) => executeManagedTool(name, argsRaw, agent.id),
      },
    }

    const runner = createRunner(modelId)
    let outputText = ''
    let toolsUsed: string[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0

    // Langfuse: create a trace for this task run (no-op when keys are not set)
    trace = createTrace({ taskId, taskTitle: task.title, agentId: agent.id, modelId })
    mainSpan = trace.startSpan('task-execution', { title: task.title, description: task.description })
    // FIFO queue of open tool span IDs — tool_call pushes, tool_result shifts
    const toolSpanQueue: string[] = []

    let pausedForApproval = false

    // Step-level checkpointing: load any existing checkpoints so we can record
    // each completed tool_result step and replay them on retry.
    const checkpoints = new Map<number, { toolName: string; result: string }>()
    const existingCheckpoints = await prisma.taskCheckpoint.findMany({
      where: { taskId },
      select: { stepIndex: true, toolName: true, result: true },
    }).catch(() => [])
    for (const c of existingCheckpoints) checkpoints.set(c.stepIndex, { toolName: c.toolName, result: c.result })
    let stepIndex = 0

    // Inject checkpoints into ctx so runners can replay without re-executing tools
    ctx.checkpoints = checkpoints.size > 0 ? checkpoints : undefined

    for await (const event of runner.run(ctx)) {
      // Check for task-level abort (60-minute timeout)
      if (taskAbort.signal.aborted) {
        throw new Error('Task exceeded maximum runtime of 60 minutes and was automatically terminated.')
      }

      switch (event.type) {
        case 'text':
          outputText += event.content
          // Store message in conversation
          await prisma.message.create({
            data: { conversationId: conversation.id, role: 'assistant', content: event.content },
          }).catch(e => err(`[worker] conversation message write failed: ${e instanceof Error ? e.message : e}`))
          break

        case 'tool_call':
          // Plan gate: a high/critical-risk plan must be approved before tools run.
          if (planBeforeExecute) {
            const plan = parsePlan(outputText)
            if (planRequiresApproval(plan)) {
              pausedForApproval = true
              break
            }
          }
          toolsUsed.push(event.tool)
          // Compute deterministic idempotency key for this tool call to prevent
          // duplicate side effects on retry.
          const idemKey = createHash('sha256')
            .update(`${taskId}:${stepIndex}:${event.tool}:${event.args ?? ''}`)
            .digest('hex')
            .slice(0, 16)
          // Langfuse: start a span for this tool call
          toolSpanQueue.push(trace.startSpan(`tool:${event.tool}`, { args: event.args }))
          await logTaskEvent(taskId, 'tool_call', `🔧 ${event.tool}(${event.args}) [idem:${idemKey}]`, agent.id)
          await prisma.message.create({
            data: {
              conversationId: conversation.id, role: 'assistant',
              content: `[tool_call] ${event.tool}`,
              metadata: { toolCall: { name: event.tool, args: event.args } } as any,
            },
          }).catch(e => err(`[worker] tool_call message write failed: ${e instanceof Error ? e.message : e}`))
          if (featureRoomId) {
            const argsSummary = String(event.args ?? '').slice(0, 200)
            await postToRoom(featureRoomId, agent.id, `🔧 \`${event.tool}\`(${argsSummary})`, taskId)
          }
          break

        case 'tool_result': {
          // MAJOR fix: redactSecrets was applied only to the room-feed copy; the
          // logTaskEvent and Message writes stored raw tool results including any
          // secrets/credentials returned by shell/kubectl/vault tools. Apply
          // redaction consistently before any write.
          const redactedResult = redactSecrets(event.result).slice(0, 2000)
          // Langfuse: end the oldest open tool span (FIFO)
          const openToolSpanId = toolSpanQueue.shift()
          if (openToolSpanId) trace.endSpan(openToolSpanId, { result: redactedResult.slice(0, 500) })
          await logTaskEvent(taskId, 'tool_result', redactedResult, agent.id)
          // Checkpoint this step so it can be detected on retry.
          stepIndex++
          const idemKeyForCheckpoint = createHash('sha256')
            .update(`${taskId}:${stepIndex}:${event.tool}:`)
            .digest('hex')
            .slice(0, 16)
          await prisma.taskCheckpoint.upsert({
            where: { taskId_stepIndex: { taskId, stepIndex } },
            update: { result: redactedResult },
            create: { taskId, stepIndex, toolName: event.tool, argsHash: idemKeyForCheckpoint, result: redactedResult },
          }).catch(e => err(`[worker] checkpoint upsert failed for task ${taskId} step ${stepIndex}: ${e instanceof Error ? e.message : e}`))
          checkpoints.set(stepIndex, { toolName: event.tool, result: redactedResult })
          await prisma.message.create({
            data: {
              conversationId: conversation.id, role: 'user',
              content: `[tool_result] ${event.tool}: ${redactedResult}`,
            },
          }).catch(e => err(`[worker] tool_result message write failed: ${e instanceof Error ? e.message : e}`))
          if (featureRoomId) {
            const safeResult = redactedResult.slice(0, 300)
            await postToRoom(featureRoomId, agent.id, `↩ \`${event.tool}\`: ${safeResult}`, taskId)
          }
          break
        }

        case 'usage':
          totalInputTokens  += event.inputTokens
          totalOutputTokens += event.outputTokens
          break

        case 'done':
          break

        case 'error':
          throw new Error(event.error)
      }

      // Stop consuming the runner once we've paused for plan approval — no
      // further tools should execute until a human approves the plan.
      if (pausedForApproval) break
    }

    // Plan-before-execute: high/critical-risk plan paused for approval. Persist
    // risk + plan text into metadata so the approval UI can surface them and
    // /api/tasks/:id/resume-plan can restore the approved plan.
    if (pausedForApproval) {
      const plan = parsePlan(outputText)
      const risk = plan?.riskLevel ?? 'high'
      const planText = plan?.raw ?? outputText.slice(0, 4000)
      const pauseMsg =
        `⏸️ **Plan paused for approval** (risk: ${risk})\n\n` +
        `Task **${task.title}** produced a ${risk}-risk plan and is awaiting human approval before any tools run.\n\n` +
        (plan?.summary ? `Summary: ${plan.summary}\n` : '') +
        (plan?.rollbackSteps?.length
          ? `Rollback steps:\n${plan.rollbackSteps.map((s) => `  - ${s}`).join('\n')}\n`
          : plan?.rollbackStrategy ? `Rollback: ${plan.rollbackStrategy}\n` : '')
      await Promise.all([
        prisma.task.update({
          where: { id: taskId },
          data: {
            status: 'pending_validation',
            metadata: {
              ...taskMeta,
              planRisk: risk,
              planContent: planText,
              planSteps: plan?.steps ?? [],
              planApproved: false,
            } as object,
          },
        }),
        logTaskEvent(taskId, 'plan_pending_approval',
          `Risk=${risk}. ${plan?.summary ?? ''}\n\n${planText}`, agent.id),
        postToFeed(agent.id, pauseMsg, taskId),
        ...(featureRoomId ? [postToRoom(featureRoomId, agent.id, pauseMsg, taskId)] : []),
      ])
      notify({ type: 'plan_approval_needed', taskId, taskTitle: task.title, agentId: agent.id, agentName: agent.name, riskLevel: risk }).catch(() => {})
      log(`Task "${task.title}" (${taskId}) paused for ${risk}-risk plan approval`)
      return
    }

    const durationSec = Math.round((Date.now() - startedAt) / 1000)
    const summary = outputText.slice(-500) || 'Task completed.'

    const completionMsg = `✅ Completed: **${task.title}** (${durationSec}s · ${toolsUsed.length} tools)\n\n${summary}`

    // Delegation result propagation
    const delegation = (task.metadata as any)?.delegation as { roomId?: string; ringLeaderId?: string } | undefined
    const roomPromises = featureRoomId ? [postToRoom(featureRoomId, agent.id, completionMsg, taskId)] : []
    if (delegation?.roomId) {
      const delegateResult = `🔔 **Delegation complete**: ${task.title}\n\n${summary}`
      roomPromises.push(postToRoom(delegation.roomId, agent.id, delegateResult, taskId))
    }

    await Promise.all([
      prisma.task.update({ where: { id: taskId }, data: { status: 'pending_validation' } }),
      logTaskEvent(taskId, 'completed', summary, agent.id),
      // SOC2: always keep postToFeed for audit trail
      postToFeed(agent.id, completionMsg, taskId),
      // Post to feature room and any delegation room
      ...roomPromises,
      prisma.claudeInvocation.create({
        data: {
          conversationId: conversation.id,
          prompt:     task.title,
          toolsUsed,
          tokensUsed: totalInputTokens + totalOutputTokens || null,
          durationMs: Date.now() - startedAt,
          success:    true,
        },
      }).catch(e => err(`[worker] claudeInvocation write failed for task ${taskId}: ${e instanceof Error ? e.message : e}`)),
    ])

    notify({ type: 'task_completed', taskId, taskTitle: task.title, agentId: agent.id, agentName: agent.name }).catch(() => {})

    // Log token usage to the task timeline when available.
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      await logTaskEvent(
        taskId,
        'usage',
        `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out (total: ${totalInputTokens + totalOutputTokens})`,
        agent.id,
      ).catch(() => {})
      // Record token spend for budget tracking
      await recordTokenUsage(agent.id, taskId, totalInputTokens, totalOutputTokens, modelId).catch(() => {})
    }

    // Auto-write the task outcome to the knowledge base so future agents learn
    // from it via vector-search context injection.
    const envName = agentGw?.environmentId
      ? (await prisma.environment.findUnique({ where: { id: agentGw.environmentId }, select: { name: true } }).catch(() => null))?.name ?? null
      : null
    await writeTaskOutcome({
      title:           task.title,
      description:     task.description,
      status:         'done',
      outcomeSummary: `Completed in ${durationSec}s using ${toolsUsed.length} tool call(s)${toolsUsed.length ? ` (${[...new Set(toolsUsed)].slice(0, 8).join(', ')})` : ''}. ${summary}`.trim(),
      environmentId:   agentGw?.environmentId ?? null,
      environmentName: envName,
    })

    // Clean up checkpoints on successful completion — no longer needed.
    await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})

    // Run reviewer check for non-persistent tasks that produced output.
    if ((task.metadata as any)?.persistent !== true) {
      await runReviewerCheck(taskId, task.title, outputText, agent.id, modelId)
    }

    // Langfuse: close the main span and flush the trace
    trace.recordGeneration({ model: modelId, input: task.title, output: outputText.slice(0, 1000), inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
    trace.endSpan(mainSpan, { summary: outputText.slice(0, 500) })
    trace.complete(outputText.slice(0, 500))
    await trace.flush()

    log(`Completed task "${task.title}" (${taskId}) in ${durationSec}s`)
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    err(`Task ${taskId} failed: ${errMsg}`)

    // Langfuse: flush trace on failure
    if (trace) {
      if (mainSpan) trace.endSpan(mainSpan, undefined, errMsg)
      await trace.flush().catch(() => {})
    }

    const failedTask = await prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, description: true, assignedAgent: true, retryCount: true, maxRetries: true, metadata: true },
    }).catch(() => null)

    // ── Remediation loop detection ──────────────────────────────────────────
    // Track how many times this task has hit the failure path with the same
    // approach. Once it has failed 2+ times we stop retrying and escalate for
    // human review instead of looping on a strategy that clearly is not working.
    const failMeta = (failedTask?.metadata as Record<string, unknown> | null) ?? {}
    const remediationAttempts = (typeof failMeta.remediation_attempts === 'number' ? failMeta.remediation_attempts : 0) + 1
    const exhaustedRemediation = remediationAttempts >= 2

    const canRetry = !exhaustedRemediation && isTransientError(errMsg) && (failedTask?.retryCount ?? 0) < (failedTask?.maxRetries ?? 3)

    if (exhaustedRemediation) {
      // Persist the incremented attempt counter and stop retrying.
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          metadata: { ...failMeta, remediation_attempts: remediationAttempts } as any,
        },
      }).catch(e => err(`[worker] task status update failed for ${taskId}: ${e instanceof Error ? e.message : e}`))
      const escalationMsg =
        `Task '${failedTask?.title ?? taskId}' has failed ${remediationAttempts} times with the same approach. Escalating — human review required. Last error: ${errMsg.slice(0, 300)}`
      await logTaskEvent(taskId, 'escalated', escalationMsg, failedTask?.assignedAgent ?? undefined)
      if (failedTask?.assignedAgent) {
        await postToFeed(failedTask.assignedAgent, `🚨 ${escalationMsg}`, taskId).catch(() => {})
      }
      // Escalate to a human operator if one exists (orion_escalate_task needs a user_id).
      const human = await prisma.user.findFirst({ select: { id: true } }).catch(() => null)
      if (human && failedTask?.assignedAgent) {
        await executeManagedTool(
          'orion_escalate_task',
          JSON.stringify({ task_id: taskId, user_id: human.id }),
          failedTask.assignedAgent,
        ).catch((e) => err(`Auto-escalation failed for ${taskId}: ${e}`))
      }
      await writeTaskOutcome({
        title:           failedTask?.title ?? taskId,
        description:     failedTask?.description ?? null,
        status:         'failed',
        outcomeSummary: `Failed ${remediationAttempts} times with the same approach — escalated for human review.`,
        errorMessage:    errMsg,
      })
      await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})
    } else if (canRetry) {
      const newRetryCount = (failedTask!.retryCount ?? 0) + 1
      const delayMs = 15000 * Math.pow(2, failedTask!.retryCount ?? 0) // 15s, 30s, 60s
      const nextRetryAt = new Date(Date.now() + delayMs)
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'pending', retryCount: newRetryCount, nextRetryAt },
      }).catch(e => err(`[worker] task retry status update failed for ${taskId}: ${e instanceof Error ? e.message : e}`))
      await logTaskEvent(taskId, 'system',
        `Transient failure (${errMsg.slice(0, 100)}) — retry ${newRetryCount}/${failedTask!.maxRetries ?? 3} scheduled in ${delayMs / 1000}s`,
        failedTask?.assignedAgent ?? undefined,
      )
    } else {
      await Promise.all([
        prisma.task.update({
          where: { id: taskId },
          data: { status: 'failed', metadata: { ...failMeta, remediation_attempts: remediationAttempts } as any },
        }).catch(() => {}),
        logTaskEvent(taskId, 'failed', errMsg, failedTask?.assignedAgent ?? undefined),
      ])
      if (failedTask?.assignedAgent) {
        await postToFeed(failedTask.assignedAgent, `❌ Failed: **${failedTask.title}**\n\n${errMsg}`, taskId).catch(() => {})
      }
      notify({ type: 'task_failed', taskId, taskTitle: failedTask?.title ?? taskId, agentId: failedTask?.assignedAgent ?? '', agentName: '', error: errMsg }).catch(() => {})
      await writeTaskOutcome({
        title:           failedTask?.title ?? taskId,
        description:     failedTask?.description ?? null,
        status:         'failed',
        outcomeSummary: `Failed after ${remediationAttempts} attempt(s).`,
        errorMessage:    errMsg,
      })
      await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})
    }
  } finally {
    clearTimeout(timeoutHandle)
    runningTasks.delete(taskId)
  }
}

// ── Plan-before-execute helpers ──────────────────────────────────────────────

export type PlanRisk = 'low' | 'medium' | 'high' | 'critical'

export interface ParsedPlan {
  summary: string | null
  riskLevel: PlanRisk | null
  estimatedDuration: string | null
  /** @deprecated prose fallback kept for backwards compat — prefer rollbackSteps */
  rollbackStrategy: string | null
  /** Execution steps from <steps> — used for partial plan approval UI. */
  steps: string[]
  /** How the agent will confirm the action worked (parsed from <verify_steps>). */
  verifySteps: string[]
  /** Concrete tool-call steps to undo the change (parsed from <rollback_steps>). */
  rollbackSteps: string[]
  raw: string
}

/**
 * Parse the structured <plan> block emitted by a plan-before-execute agent.
 * Returns null if no <plan> block is present yet (agent still streaming prose).
 */
export function parsePlan(text: string): ParsedPlan | null {
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/i)
  if (!planMatch) return null
  const body = planMatch[1]
  const tag = (name: string): string | null => {
    const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
    return m ? m[1].trim() : null
  }
  // Extract a list of <step> elements from a named container tag.
  const stepList = (containerName: string): string[] => {
    const container = body.match(new RegExp(`<${containerName}>([\\s\\S]*?)</${containerName}>`, 'i'))
    if (!container) return []
    return Array.from(container[1].matchAll(/<step>([\s\S]*?)<\/step>/gi))
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0)
  }
  const rawRisk = tag('risk_level')?.toLowerCase() ?? null
  const riskLevel: PlanRisk | null =
    rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high' || rawRisk === 'critical'
      ? rawRisk
      : null
  return {
    summary: tag('summary'),
    riskLevel,
    estimatedDuration: tag('estimated_duration'),
    rollbackStrategy: tag('rollback_strategy'),
    steps: stepList('steps'),
    verifySteps: stepList('verify_steps'),
    rollbackSteps: stepList('rollback_steps'),
    raw: planMatch[0],
  }
}

/** High/critical-risk plans must be approved by a human before tools run. */
export function planRequiresApproval(plan: ParsedPlan | null): boolean {
  return plan?.riskLevel === 'high' || plan?.riskLevel === 'critical'
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function logTaskEvent(taskId: string, eventType: string, content: string, agentId?: string) {
  await prisma.taskEvent.create({ data: { taskId, eventType, content, agentId: agentId ?? null } }).catch(e => err(`[worker] logTaskEvent failed for task ${taskId}: ${e instanceof Error ? e.message : e}`))
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

/**
 * Auto-write a structured task outcome to the knowledge base as an `llm-context`
 * note. These notes are embedded for vector search and auto-injected into future
 * agent system prompts, so completed/failed task outcomes become institutional
 * memory without an agent having to explicitly call knowledge_remember.
 */
async function writeTaskOutcome(opts: {
  title: string
  description: string | null
  status: 'done' | 'failed'
  outcomeSummary: string
  errorMessage?: string | null
  environmentId?: string | null
  environmentName?: string | null
}): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10)
    const desc = (opts.description ?? '').trim()
    const parts = [
      `Task '${opts.title}' ${opts.status} on ${date}: ${desc || '(no description)'}. ${opts.outcomeSummary}`.trim(),
    ]
    if (opts.environmentName) parts.push(`\nEnvironment: ${opts.environmentName}`)
    if (opts.status === 'failed' && opts.errorMessage) parts.push(`\nError: ${opts.errorMessage.slice(0, 1000)}`)
    const content = redactSecrets(parts.join('')).slice(0, MAX_NOTE_LENGTH)

    const tags: string[] = ['task-outcome', opts.status]
    if (opts.environmentId) tags.push(opts.environmentId)

    const note = await prisma.note.create({
      data: {
        title:   `Task outcome: ${opts.title.slice(0, 120)} (${opts.status} ${date})`,
        content,
        folder:  'Task Outcomes',
        type:    'llm-context',
        tags:    tags as any,
      },
    })

    // Embed immediately so the outcome is retrievable via knowledge_search / RAG.
    const { embedNote } = await import('./lib/embeddings')
    await embedNote(note).catch(() => false)
  } catch (e) {
    err(`writeTaskOutcome failed for "${opts.title}": ${e}`)
  }
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
      .update({ where: { id: existing.id }, data: { content, tags: ['last-directives'] as any, updatedAt: new Date() } })
      .catch(() => {})
  } else {
    await prisma.note
      .create({ data: { title, content, folder: 'Watcher State', type: 'watcher-state', tags: ['last-directives'] as any } })
      .catch(() => {})
  }
}

/** Extract task IDs referenced in watcher output (e.g. "[abc123]") for loop-detection. */
function extractTaskIds(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[([a-z0-9]{20,})\]/gi)).map((m) => m[1])))
}

async function runWatchers() {
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
      retrieveKnowledgeContext(meta.systemPrompt as string ?? agent.name, 5, 0.2).catch(() => ''),
      buildSystemSnapshot(),
      getSystemRooms(),
      loadWatcherState(agent.id),
    ])

    const wikiContext = rawKnowledge
      ? `\n\n---\n## Relevant Knowledge Base Context\n${rawKnowledge}\n---\n\n`
      : ''

    // Inject tool awareness preamble into watcher system prompt — same as task runner
    const watcherToolList = [
      ...MANAGEMENT_TOOL_DEFS.map((t: any) => `- ${t.name}: ${t.description.split('\n')[0]}`),
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
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          metadata: {
            ...(agent.metadata as object ?? {}),
            watcherLastRun: Date.now()
          }
        }
      }).catch(() => { /* non-critical — next run will re-calculate from old lastRun */ })
      runningWatchers.delete(agent.id)
    }
  }
}

// ── GitOps PR sync ─────────────────────────────────────────────────────────────

/**
 * Poll Gitea for open PRs across all environments.
 * - Discovers new orion/auto/* PRs not yet tracked in the DB
 * - Updates status of existing tracked PRs that have since been merged or closed
 * Runs every 60s as a fallback for when webhooks don't fire.
 */
async function syncGitOpsPRs() {
  const { getGitProvider } = await import('./lib/git-provider')
  let provider: Awaited<ReturnType<typeof getGitProvider>>
  try {
    provider = await getGitProvider()
    if (!(await provider.isHealthy())) return
  } catch {
    return
  }

  // ── 1. Discover open PRs from Gitea and upsert into DB ──────────────────────
  const envs = await prisma.environment.findMany({
    where: { gitOwner: { not: null }, gitRepo: { not: null } },
    select: { id: true, gitOwner: true, gitRepo: true },
  })

  for (const env of envs) {
    if (!env.gitOwner || !env.gitRepo) continue
    try {
      const remotePRs = await provider.listOpenPRs(env.gitOwner, env.gitRepo)
      for (const rpr of remotePRs) {
        if (!rpr.headBranch.startsWith('orion/')) continue
        await prisma.gitOpsPR.upsert({
          where: { environmentId_prNumber: { environmentId: env.id, prNumber: rpr.number } },
          create: {
            environmentId: env.id,
            prNumber:      rpr.number,
            title:         rpr.title,
            operation:     'unknown',
            decision:      'review',
            status:        'open',
            prUrl:         rpr.htmlUrl,
            branch:        rpr.headBranch,
          },
          update: {},
        })
      }
    } catch {
      // Non-fatal
    }
  }

  // ── 2. Update status of tracked open PRs that have since been merged/closed ──
  const openPRs = await prisma.gitOpsPR.findMany({
    where: { status: 'open' },
    include: { environment: { select: { gitOwner: true, gitRepo: true } } },
  })

  for (const pr of openPRs) {
    const { gitOwner, gitRepo } = pr.environment
    if (!gitOwner || !gitRepo) continue

    try {
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
      // Non-fatal
    }
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

// How long (ms) a task may sit in pending_validation before auto-escalating.
const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS ?? '') || 30 * 60 * 1000

/**
 * Escalate tasks that have been waiting for plan approval longer than
 * APPROVAL_TIMEOUT_MS (default 30 min). Posts to agent feed and assigns to the
 * first available human so the UI surfaces it as a blocked task.
 */
async function escalateStalePendingValidation(): Promise<void> {
  const cutoff = new Date(Date.now() - APPROVAL_TIMEOUT_MS)
  const staleTasks = await prisma.task.findMany({
    where: { status: 'pending_validation', updatedAt: { lt: cutoff } },
    select: { id: true, title: true, assignedAgent: true, metadata: true, updatedAt: true },
  })
  if (staleTasks.length === 0) return

  const human = await prisma.user.findFirst({ select: { id: true } }).catch(() => null)

  for (const t of staleTasks) {
    const waitMins = Math.round((Date.now() - t.updatedAt.getTime()) / 60_000)
    const msg = `⏰ **Approval timeout**: Task **${t.title}** has been waiting for plan approval for ${waitMins} minutes. Escalating for human review.`
    log(`Escalating stale pending_validation task ${t.id} (${waitMins}m)`)

    await Promise.all([
      logTaskEvent(t.id, 'escalated', msg, t.assignedAgent ?? undefined),
      t.assignedAgent ? postToFeed(t.assignedAgent, msg, t.id).catch(() => {}) : Promise.resolve(),
      // Assign to the first human so it appears in their task queue.
      human
        ? prisma.task.update({
            where: { id: t.id },
            data: {
              assignedUserId: human.id,
              metadata: { ...(t.metadata as object ?? {}), approvalEscalatedAt: new Date().toISOString() } as object,
            },
          }).catch(() => {})
        : Promise.resolve(),
    ])
  }
}

/**
 * Poll all in-flight federated tasks for completion.
 * Fetches status from each spoke and marks the local task done/failed to match.
 */
const FED_POLL_MAX_FAILURES = 5          // give up after 5 consecutive failures
const FED_POLL_MAX_AGE_MS   = 24 * 60 * 60 * 1000  // abandon dispatches older than 24h

async function pollFederatedTasks(): Promise<void> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - FED_POLL_MAX_AGE_MS)

  const dispatches = await prisma.federatedDispatch.findMany({
    where: { status: { in: ['dispatched', 'acknowledged'] } },
    select: { id: true, taskId: true, spokeUrl: true, status: true, failCount: true, dispatchedAt: true },
  })
  if (dispatches.length === 0) return

  const token = process.env.ORION_GATEWAY_TOKEN ?? ''

  await Promise.all(dispatches.map(async (dispatch) => {
    // Abandon dispatches that are too old or have failed too many times
    if (dispatch.dispatchedAt < cutoff || dispatch.failCount >= FED_POLL_MAX_FAILURES) {
      await prisma.$transaction([
        prisma.task.update({ where: { id: dispatch.taskId }, data: { status: 'failed' } }),
        prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'failed' } }),
      ])
      err(`Federated task ${dispatch.taskId} abandoned — ${dispatch.failCount >= FED_POLL_MAX_FAILURES ? `${dispatch.failCount} consecutive failures` : 'dispatch age exceeded 24h'}`)
      return
    }

    try {
      const res = await fetch(`${dispatch.spokeUrl}/api/federation/tasks/${dispatch.taskId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })

      if (!res.ok) {
        await prisma.federatedDispatch.update({
          where: { id: dispatch.id },
          data: { failCount: { increment: 1 }, lastPolledAt: now },
        })
        return
      }

      const data = (await res.json()) as { status: string }
      const spokeStatus = data.status

      if (spokeStatus === 'done' || spokeStatus === 'failed') {
        await prisma.$transaction([
          prisma.task.update({ where: { id: dispatch.taskId }, data: { status: spokeStatus } }),
          prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'completed', completedAt: now, failCount: 0, lastPolledAt: now } }),
        ])
        log(`Federated task ${dispatch.taskId} completed on spoke with status: ${spokeStatus}`)
      } else if (spokeStatus === 'in_progress' && dispatch.status === 'dispatched') {
        await prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'acknowledged', acknowledgedAt: now, failCount: 0, lastPolledAt: now } })
      } else {
        await prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { failCount: 0, lastPolledAt: now } })
      }
    } catch (e) {
      err(`Failed to poll federated task ${dispatch.taskId} at ${dispatch.spokeUrl}: ${e instanceof Error ? e.message : String(e)}`)
      await prisma.federatedDispatch.update({
        where: { id: dispatch.id },
        data: { failCount: { increment: 1 }, lastPolledAt: now },
      }).catch(() => {})
    }
  }))
}

async function pollOnce() {
  if (runningTasks.size >= MAX_CONCURRENT) return

  const available = MAX_CONCURRENT - runningTasks.size

  // Candidate pending tasks. Two gates beyond status='pending':
  //  1. feature.planApprovedAt must be set — no feature-scoped task runs until
  //     its feature plan is approved by a human (the plan-approval gate).
  //     Tasks with no feature (ad-hoc/system tasks) are exempt.
  //  2. all task.dependsOn IDs must be 'done' — checked in-memory below because
  //     Postgres can't relationally filter "every element of this scalar array
  //     is in a done-set".
  // Ordered by wave so earlier waves drain before later ones.
  const pending = await prisma.task.findMany({
    where: {
      status:        'pending',
      assignedAgent: { not: null },
      AND: [
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
        {
          OR: [
            { featureId: null },
            { feature: { planApprovedAt: { not: null } } },
          ],
        },
      ],
      agent: {
        NOT: {
          metadata: { path: ['archived'], equals: true },
        },
      },
    },
    orderBy: [{ wave: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, dependsOn: true },
  })

  if (pending.length === 0) return

  // Build the set of completed task IDs referenced by any candidate's deps.
  const depIds = [...new Set(pending.flatMap(t => t.dependsOn))]
  const completedTaskIds = new Set<string>()
  if (depIds.length > 0) {
    const doneDeps = await prisma.task.findMany({
      where: { id: { in: depIds }, status: 'done' },
      select: { id: true },
    })
    for (const d of doneDeps) completedTaskIds.add(d.id)
  }

  let launched = 0
  for (const task of pending) {
    if (launched >= available) break
    // Dependency gate: every depended-upon task must be done.
    if (!task.dependsOn.every(depId => completedTaskIds.has(depId))) continue
    if (!runningTasks.has(task.id)) {
      runTask(task.id).catch(e => err(`Unhandled error in runTask(${task.id}): ${e}`))
      launched++
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

async function main() {
  log('Orchestrator starting…')

  // Wait for the DB to be ready (give Next.js time to run prisma db push)
  await new Promise(resolve => setTimeout(resolve, 5_000))

  // Load tunable settings from DB so operators can change them without redeploying
  const [pollSetting, concurrentSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'worker.pollIntervalMs' } }).catch(() => null),
    prisma.systemSetting.findUnique({ where: { key: 'worker.maxConcurrent' } }).catch(() => null),
  ])
  if (pollSetting?.value) {
    const v = parseInt(String(pollSetting.value), 10)
    if (v >= 1000 && v <= 300_000) POLL_INTERVAL_MS = v
  }
  if (concurrentSetting?.value) {
    const v = parseInt(String(concurrentSetting.value), 10)
    if (v >= 1 && v <= 20) MAX_CONCURRENT = v
  }

  log(`Polling every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_CONCURRENT} concurrent tasks`)

  // Recover any tasks that were in_progress when the worker last crashed
  await recoverStuckTasks().catch(e => err(`Startup recovery failed: ${e}`))

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
    if (runningGitOpsSync) return
    runningGitOpsSync = true
    syncGitOpsPRs().catch(e => err(`GitOps PR sync failed: ${e}`)).finally(() => { runningGitOpsSync = false })
  }, 60_000)

  // Dream — memory consolidation covers three phases:
  //   extraction (every 2h): scans recent chat messages + task events, extracts durable
  //     facts/lessons as llm-context notes with [[wikilinks]], immediately embeds them
  //     for vector search retrieval.
  //   synthesis (every 12h): identifies missing "hub" notes that connect clusters of
  //     related specific notes into a coherent knowledge graph.
  //   pruning (every 24h): reviews notes older than 7 days, flags or deletes stale ones.
  //   model: configurable via dream.model SystemSetting (falls back to system default).
  // No additional consolidation pass is needed — episodic→semantic promotion is handled
  // entirely by the LLM-based extraction pass above.
  startDream()

  // Security correlator — poll for uncorrelated events every 30s
  setInterval(() => {
    if (runningCorrelator) return
    runningCorrelator = true
    runCorrelator().catch(e => err(`Security correlator failed: ${e}`)).finally(() => { runningCorrelator = false })
  }, 30_000)

  // K8s events poller — every 30s per the Phase 2 plan.
  setInterval(() => {
    if (runningK8sPoller) return
    runningK8sPoller = true
    runK8sPollerAll().catch(e => err(`K8s poller failed: ${e}`)).finally(() => { runningK8sPoller = false })
  }, 30_000)

  // ELK poller — every 15s. No-ops if ELK_URL is not set.
  setInterval(() => {
    if (runningElkPoller) return
    runningElkPoller = true
    runElkPollerAll().catch(e => err(`ELK poller failed: ${e}`)).finally(() => { runningElkPoller = false })
  }, 15_000)

  // ntopng poller — every 30s. No-ops if NTOPNG_URL is not set.
  setInterval(() => {
    if (runningNtopngPoller) return
    runningNtopngPoller = true
    runNtopngPollerAll().catch(e => err(`ntopng poller failed: ${e}`)).finally(() => { runningNtopngPoller = false })
  }, 30_000)

  // CrowdSec decision sync — refresh the application-layer blocklist every 60s.
  // Runs independently of the ntopng/ELK pollers so a slow LAPI doesn't block
  // event ingestion. syncCrowdSecDecisions() has its own internal debounce so
  // calling it on a 30s interval is harmless.
  setInterval(() => {
    syncCrowdSecDecisions().catch(e => err(`CrowdSec sync failed: ${e}`))
  }, 30_000)

  // ── Phase 3: vulnerability scanning ───────────────────────────────────────
  setInterval(() => {
    if (runningVulnScan) return
    runningVulnScan = true
    runEventTriggeredScan().catch(e => err(`Event-triggered vuln scan failed: ${e}`)).finally(() => { runningVulnScan = false })
  }, 60_000)

  // Daily scheduled scan — once a day at 02:00 server time. Implemented as
  // a guard inside an hourly tick so we don't need a separate scheduler
  // library and the timing self-heals across worker restarts.
  // lastDailyScanDate is persisted to DB so a restart between 02:00-03:00
  // doesn't re-run the scan, and a restart that spans 02:00 doesn't skip it.
  const runScheduledDailyScan = () => {
    const now = new Date()
    const dateKey = now.toISOString().slice(0, 10)
    prisma.systemSetting.findUnique({ where: { key: 'worker.lastDailyScanDate' } })
      .then(async row => {
        if (row?.value === dateKey) return
        const localhostEnv = await prisma.environment.findFirst({ where: { name: 'localhost' }, select: { id: true } }).catch(() => null)
        const scan = localhostEnv ? await prisma.vulnerabilityScan.create({
          data: { environmentId: localhostEnv.id, driver: 'trivy', status: 'running', triggeredBy: 'schedule', startedAt: new Date() },
        }).catch(() => null) : null
        try {
          const results = await runDailyScan(undefined, 'trivy', scan?.id)
          const totals = results.reduce(
            (acc, r) => ({
              findingsCreated: acc.findingsCreated + r.findingsCreated,
              findingsEscalated: acc.findingsEscalated + r.findingsEscalated,
              findingsFixed: acc.findingsFixed + r.findingsFixed,
            }),
            { findingsCreated: 0, findingsEscalated: 0, findingsFixed: 0 }
          )
          if (scan) {
            await prisma.vulnerabilityScan.update({
              where: { id: scan.id },
              data: { status: 'completed', completedAt: new Date(), ...totals },
            }).catch(() => {})
          }
          await prisma.systemSetting.upsert({
            where: { key: 'worker.lastDailyScanDate' },
            update: { value: dateKey },
            create: { key: 'worker.lastDailyScanDate', value: dateKey },
          })
        } catch (e) {
          err(`Daily vuln scan failed: ${e}`)
          if (scan) {
            await prisma.vulnerabilityScan.update({
              where: { id: scan.id },
              data: { status: 'failed', completedAt: new Date(), errorMessage: String(e) },
            }).catch(() => {})
          }
        }
      })
      .catch(e => err(`Daily scan guard failed: ${e}`))
  }

  // Startup catch-up: if the worker restarted and we missed 02:00, run the scan now.
  {
    const now = new Date()
    const dateKey = now.toISOString().slice(0, 10)
    prisma.systemSetting.findUnique({ where: { key: 'worker.lastDailyScanDate' } })
      .then(row => { if (row?.value !== dateKey) runScheduledDailyScan() })
      .catch(() => {})
  }

  setInterval(() => {
    const now = new Date()
    if (now.getHours() !== 2) return
    runScheduledDailyScan()
  }, 60 * 60 * 1000)

  // Goal heartbeat — every 5 min, re-trigger agents in rooms whose active goal
  // has gone stale (no non-system message for 15 min). See jobs/goal-heartbeat.ts.
  setInterval(() => {
    runGoalHeartbeat().catch(e => err(`Goal heartbeat failed: ${e}`))
  }, 5 * 60_000)

  // Cron scheduler — check every 60s for scheduled tasks due to run
  setInterval(() => {
    if (runningScheduler) return
    runningScheduler = true
    runScheduler().catch(e => err(`Task scheduler failed: ${e}`)).finally(() => { runningScheduler = false })
  }, 60_000)

  // HITL approval timeout escalation — every 5 min, escalate tasks that have
  // been waiting for plan approval longer than APPROVAL_TIMEOUT_MS (default 30 min).
  setInterval(() => {
    escalateStalePendingValidation().catch(e => err(`Approval timeout escalation failed: ${e}`))
  }, 5 * 60_000)

  // GitOps drift detection — every 5 min, compare live cluster state to desired state.
  setInterval(() => {
    if (runningDriftDetector) return
    runningDriftDetector = true
    detectGitOpsDrift().catch(e => err(`GitOps drift detection failed: ${e}`)).finally(() => { runningDriftDetector = false })
  }, 5 * 60_000)

  // Federation spoke polling — every 60s, check in-flight federated tasks for completion.
  setInterval(() => {
    if (runningFedPoller) return
    runningFedPoller = true
    pollFederatedTasks().catch(e => err(`Federation spoke polling failed: ${e}`)).finally(() => { runningFedPoller = false })
  }, 60_000)

}

process.on('unhandledRejection', (reason, promise) => {
  process.stderr.write(`[orchestrator] Unhandled rejection at: ${promise}\nReason: ${reason}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`[orchestrator] Uncaught exception: ${err.message}\n${err.stack ?? ''}\n`)
  process.exit(1)
})

main().catch(e => { err(`Fatal: ${e}`); process.exit(1) })

// Graceful shutdown on SIGTERM (container stop / redeploy).
// Without this, in-flight tasks are killed mid-run and left as 'in_progress'
// in the DB, requiring recoverStuckTasks on the next startup (up to 30 min).
// We stop polling new tasks and wait up to 60s for running tasks to drain.
async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal} — draining in-flight tasks (max 60s)...`)
  const deadline = Date.now() + 60_000
  while ((runningTasks.size > 0 || runningWatchers.size > 0) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (runningTasks.size > 0) err(`Shutdown: ${runningTasks.size} task(s) still running at deadline — exiting anyway`)
  log('Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })
