import crypto from 'crypto'
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Classification, RiskTier } from './classifier.js'
import type { ExecuteResult } from './sandbox.js'
import type { ToolExecution } from './orion-client.js'

type Tool = 'shell_exec' | 'file_read' | 'system_info'
type ActorType = 'agent' | 'human'

// Narrow interfaces for the collaborators, so tests can pass fakes.
export interface OrionApi {
  createExecution(data: {
    executionId: string
    tool: string
    args: Record<string, unknown>
    actorId: string
    actorType: ActorType
    status: string
  }): Promise<{ execution: ToolExecution; created: boolean }>
  getExecution(id: string): Promise<ToolExecution>
  updateExecution(id: string, data: Partial<ToolExecution>): Promise<ToolExecution>
  listExecutions(params?: { status?: string }): Promise<ToolExecution[]>
  notifyRoom(roomId: string, message: string): Promise<void>
  getSystemSetting(key: string): Promise<string | null>
}

export interface EventSink {
  emit(event: {
    executionId: string
    tool: string
    actorId: string
    actorType: ActorType
    riskTier: string
    status: string
    reviewDecision?: string
    exitCode?: number
    durationMs?: number
    reviewerId?: string
  }): Promise<void>
}

export interface Deps {
  orion: OrionApi
  events: EventSink
  sandbox: { execute(tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number; allowShell?: boolean }): Promise<ExecuteResult> }
  classifier: { classifyDetailed(tool: string, args: Record<string, unknown>): Classification }
  redactor: { redactArgs(args: Record<string, unknown>): Record<string, unknown>; redactOutput(s: string): string }
  validateToken: (token: string) => boolean
  approveTimeoutSeconds?: number
  escalateTtlSeconds?: number
  commandTimeoutMs?: number
  /** Base polling interval for approval decisions (tests shorten it). */
  pollIntervalMs?: number
  logger?: boolean
}

/** A command awaiting human review. Held ONLY in executor memory — see pollForApproval. */
interface PendingExecution {
  tool: Tool
  args: Record<string, unknown>
  argsHash: string
  /** Hash of the redacted args as stored in ORION: the version the reviewer was shown. */
  storedArgsHash: string
  actorId: string
  actorType: ActorType
  riskTier: RiskTier
}

/** Deterministic JSON (sorted keys) so hashes don't depend on key order after a DB round-trip. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function hashArgs(args: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(args)).digest('hex')
}

const EXECUTE_BODY_SCHEMA = {
  type: 'object',
  required: ['tool', 'args', 'actorId', 'actorType', 'executionId'],
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: ['shell_exec', 'file_read', 'system_info'] },
    args: { type: 'object' },
    actorId: { type: 'string', minLength: 1, maxLength: 200 },
    actorType: { type: 'string', enum: ['agent', 'human'] },
    executionId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const

const REVIEW_BODY_SCHEMA = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'denied'] },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    reviewerId: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

export function buildApp(deps: Deps) {
  const {
    orion,
    events,
    sandbox,
    classifier,
    redactor,
    validateToken,
    approveTimeoutSeconds = 90,
    escalateTtlSeconds = 3600,
    commandTimeoutMs = 30000,
    pollIntervalMs = 2000,
  } = deps

  const fastify: FastifyInstance = Fastify({ logger: deps.logger ?? false })

  // Commands awaiting approval, keyed by ORION execution id.
  const pending = new Map<string, PendingExecution>()
  const activePolling = new Map<string, AbortController>()
  const inFlight = new Set<Promise<unknown>>()
  let shuttingDown = false

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})
    return p
  }

  /** ORION updates must not turn a finished command into a 500 — log and carry on. */
  const safeUpdate = async (id: string, data: Partial<ToolExecution>) => {
    try {
      await orion.updateExecution(id, data)
    } catch (err) {
      fastify.log.error({ err }, `Failed to update execution ${id}`)
    }
  }

  const notifyExecutionRoom = async (message: string) => {
    try {
      const roomId = await orion.getSystemSetting('system.room.execution')
      if (roomId) await orion.notifyRoom(roomId, message)
    } catch (err) {
      fastify.log.error({ err }, 'Failed to notify execution room')
    }
  }

  const requireExecutorToken = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers['x-executor-token']
    if (typeof token !== 'string' || !validateToken(token)) {
      // Explicitly return the reply so Fastify halts the lifecycle here regardless of
      // version-specific behavior around reply.sent.
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }

  async function executeCommand(
    id: string,
    p: { tool: Tool; args: Record<string, unknown>; actorId: string; actorType: ActorType; riskTier: RiskTier },
    allowShell: boolean,
    reviewerId?: string,
  ): Promise<{ status: string; output?: string; error?: string; exitCode?: number }> {
    try {
      const result = await sandbox.execute(p.tool, p.args, { timeoutMs: commandTimeoutMs, allowShell })
      const output = redactor.redactOutput(result.stdout + result.stderr)
      // The command ran; a non-zero exit (e.g. grep with no match) is reported via exitCode, not
      // as a failed execution. exitCode is always numeric — ORION stores it in an Int column.
      const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1
      const status = 'completed'
      await safeUpdate(id, { status, output, exitCode, durationMs: result.durationMs, completedAt: new Date() })
      await events.emit({
        executionId: id, tool: p.tool, actorId: p.actorId, actorType: p.actorType, riskTier: p.riskTier,
        status, exitCode, durationMs: result.durationMs, reviewerId,
        ...(reviewerId ? { reviewDecision: 'approved' } : {}),
      })
      return { status, output, exitCode }
    } catch (error) {
      const errorMsg = redactor.redactOutput(error instanceof Error ? error.message : 'Unknown error')
      await safeUpdate(id, { status: 'failed', output: errorMsg, exitCode: 1, completedAt: new Date() })
      await events.emit({
        executionId: id, tool: p.tool, actorId: p.actorId, actorType: p.actorType, riskTier: p.riskTier, status: 'failed', reviewerId,
      })
      return { status: 'failed', error: errorMsg }
    }
  }

  async function deny(id: string, reason: string, p?: { tool: string; actorId: string; actorType: ActorType; riskTier: string }) {
    pending.delete(id)
    await safeUpdate(id, {
      status: 'denied',
      reviewDecision: 'denied',
      reviewedAt: new Date(),
      completedAt: new Date(),
      output: reason,
    })
    if (p) {
      await events.emit({ executionId: id, tool: p.tool, actorId: p.actorId, actorType: p.actorType, riskTier: p.riskTier, status: 'denied', reviewDecision: 'denied' })
    }
  }

  /**
   * Wait for a human decision on `id`. On approval, run ONLY the arguments this executor received
   * directly from the caller — never arguments read back from ORION, which are redacted and could
   * have been rewritten after the reviewer looked at them.
   */
  async function pollForApproval(id: string, timeoutSeconds: number): Promise<void> {
    const controller = new AbortController()
    activePolling.set(id, controller)
    const deadline = Date.now() + timeoutSeconds * 1000
    let backoff = pollIntervalMs
    const maxBackoff = Math.max(pollIntervalMs, 30000)

    try {
      while (!controller.signal.aborted) {
        const p = pending.get(id)
        if (!p) return // denied via the review endpoint, or already handled

        if (Date.now() >= deadline) {
          await deny(id, `auto-denied after ${timeoutSeconds}s without a decision`, p)
          await notifyExecutionRoom(`⏱ Execution ${id} auto-denied after ${timeoutSeconds}s timeout`)
          return
        }

        let current: ToolExecution
        try {
          current = await orion.getExecution(id)
          backoff = pollIntervalMs
        } catch (err) {
          // A transient ORION error must not strand the request as `pending` forever: keep
          // polling with backoff until the decision arrives or the deadline passes.
          fastify.log.warn({ err }, `Polling ${id} failed; retrying in ${backoff}ms`)
          await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())), controller.signal)
          backoff = Math.min(backoff * 2, maxBackoff)
          continue
        }

        if (current.reviewDecision === 'denied' || current.status === 'denied') {
          pending.delete(id)
          await events.emit({ executionId: id, tool: p.tool, actorId: p.actorId, actorType: p.actorType, riskTier: p.riskTier, status: 'denied', reviewDecision: 'denied', reviewerId: current.reviewerId ?? undefined })
          return
        }

        if (current.reviewDecision === 'approved') {
          pending.delete(id)
          // The approval must name a reviewer other than the requester. This also covers an
          // approval written straight into ORION rather than through /executions/:id/review.
          if (!current.reviewerId || current.reviewerId === p.actorId) {
            await deny(id, 'approval rejected: it must be made by a reviewer other than the requester', p)
            return
          }
          if (hashArgs(p.args) !== p.argsHash) {
            await deny(id, 'approval rejected: in-memory arguments failed integrity check', p)
            return
          }
          if (hashArgs(current.args) !== p.storedArgsHash) {
            await deny(id, 'approval rejected: stored arguments changed after the request was made', p)
            return
          }
          await safeUpdate(id, { status: 'running' })
          await executeCommand(id, p, true, current.reviewerId)
          return
        }

        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), controller.signal)
      }
    } finally {
      activePolling.delete(id)
    }
  }

  fastify.get('/health', async () => ({ status: shuttingDown ? 'shutting_down' : 'ok' }))

  fastify.post<{
    Body: { tool: Tool; args: Record<string, unknown>; actorId: string; actorType: ActorType; executionId: string }
  }>('/execute', { onRequest: requireExecutorToken, schema: { body: EXECUTE_BODY_SCHEMA } }, async (request, reply) => {
    if (shuttingDown) return reply.status(503).send({ error: 'Executor is shutting down' })
    const { tool, args, actorId, actorType, executionId } = request.body

    if (tool === 'shell_exec' && (typeof args.command !== 'string' || !args.command.trim())) {
      return reply.status(400).send({ error: 'shell_exec requires args.command' })
    }
    if (tool === 'file_read' && (typeof args.path !== 'string' || !args.path)) {
      return reply.status(400).send({ error: 'file_read requires args.path' })
    }

    const storedArgs = redactor.redactArgs(args)
    const { execution, created } = await orion.createExecution({
      executionId,
      tool,
      args: storedArgs,
      actorId,
      actorType,
      status: 'pending',
    })

    // executionId is idempotent in ORION: a repeat returns the existing row. Never execute for
    // a row we didn't just create — that would replay an old (possibly approved) request.
    if (!created || pending.has(execution.id) || activePolling.has(execution.id)) {
      return reply.status(409).send({
        error: 'Execution already exists; it will not be run again',
        executionId: execution.id,
        status: execution.status,
      })
    }

    const { tier: riskTier, reason } = classifier.classifyDetailed(tool, args)
    if (reason) request.log.info({ executionId: execution.id, reason }, `Escalated to ${riskTier}`)

    const p = { tool, args, actorId, actorType, riskTier }

    if (riskTier === 'auto' || riskTier === 'notify') {
      await safeUpdate(execution.id, { riskTier, status: 'running' })
      const result = await track(executeCommand(execution.id, p, false))
      if (riskTier === 'notify') {
        await notifyExecutionRoom(
          `🔔 EXECUTED [notify]\n  ID: ${execution.id}\n  Tool: ${tool}\n  Actor: ${actorId} (${actorType})\n  Status: ${result.status}`
        )
      }
      return { executionId: execution.id, ...result }
    }

    // approve / escalate: hold the original arguments in memory until a human decides.
    const timeoutSeconds = riskTier === 'escalate' ? escalateTtlSeconds : approveTimeoutSeconds
    pending.set(execution.id, {
      ...p,
      argsHash: hashArgs(args),
      storedArgsHash: hashArgs(storedArgs),
    })
    await safeUpdate(execution.id, {
      riskTier,
      status: 'pending',
      expiresAt: new Date(Date.now() + timeoutSeconds * 1000),
    })

    await notifyExecutionRoom(
      `⚡ EXECUTION REQUEST [${riskTier}]\n  ID: ${execution.id}\n  Tool: ${tool}\n  Actor: ${actorId} (${actorType})\n  Risk Tier: ${riskTier}` +
      (reason ? `\n  Why: ${reason}` : '') +
      `\n\nA human reviewer other than the requester must call approve_execution("${execution.id}", reason) or deny_execution("${execution.id}", reason)`
    )

    track(pollForApproval(execution.id, timeoutSeconds)).catch(err => {
      fastify.log.error({ err }, `Polling error for ${execution.id}`)
    })

    return { executionId: execution.id, status: 'pending', message: `Awaiting ${riskTier} decision`, expiresInSeconds: timeoutSeconds }
  })

  fastify.get<{ Params: { id: string } }>('/executions/:id', { onRequest: requireExecutorToken }, async request => {
    return orion.getExecution(request.params.id)
  })

  fastify.post<{
    Params: { id: string }
    Body: { decision: 'approved' | 'denied'; reason: string; reviewerId?: string }
  }>('/executions/:id/review', { onRequest: requireExecutorToken, schema: { body: REVIEW_BODY_SCHEMA } }, async (request, reply) => {
    const { id } = request.params
    const { decision, reason, reviewerId } = request.body

    if (decision === 'approved' && !reviewerId) {
      return reply.status(400).send({ error: 'reviewerId is required to approve an execution' })
    }

    const execution = await orion.getExecution(id)
    if (execution.status !== 'pending' || execution.reviewDecision) {
      return reply.status(409).send({ error: `Execution is ${execution.reviewDecision ?? execution.status}; it can no longer be reviewed` })
    }

    if (decision === 'denied') {
      const p = pending.get(id)
      pending.delete(id)
      activePolling.get(id)?.abort()
      await orion.updateExecution(id, {
        status: 'denied',
        reviewDecision: 'denied',
        reviewerId: reviewerId ?? null,
        reviewedAt: new Date(),
        completedAt: new Date(),
        output: `Denied: ${reason}`,
      })
      if (p) {
        await events.emit({ executionId: id, tool: p.tool, actorId: p.actorId, actorType: p.actorType, riskTier: p.riskTier, status: 'denied', reviewDecision: 'denied', reviewerId })
      }
      return { status: 'denied' }
    }

    if (reviewerId === execution.actorId) {
      return reply.status(403).send({ error: 'The requester cannot approve their own execution' })
    }
    if (!pending.has(id)) {
      // Nothing to run: the original arguments only live in this process (e.g. after a restart).
      return reply.status(409).send({ error: 'Execution is no longer awaiting approval in this executor' })
    }

    await orion.updateExecution(id, {
      reviewDecision: 'approved',
      reviewerId,
      reviewedAt: new Date(),
    })
    // The polling loop verifies the approval and runs the command.
    return { status: 'processing' }
  })

  /**
   * After a restart the original (unredacted) arguments are gone, so no pending execution can be
   * run faithfully — deny them all rather than executing whatever ORION's copy says.
   */
  async function rehydratePendingExecutions() {
    try {
      fastify.log.info('Reconciling pending executions...')
      const rows = await orion.listExecutions({ status: 'pending' })
      let denied = 0
      for (const row of rows) {
        if (pending.has(row.id)) continue
        await deny(row.id, 'auto-denied: executor restarted before a decision; resubmit the request')
        await notifyExecutionRoom(`⏱ Execution ${row.id} auto-denied on executor restart — resubmit if still needed`)
        denied++
      }
      fastify.log.info(`Reconciliation complete — auto-denied: ${denied}`)
    } catch (error) {
      fastify.log.error({ err: error }, 'Reconciliation of pending executions failed')
    }
  }

  /** Stop taking work, let running commands finish (up to graceMs), and deny nothing mid-flight. */
  async function shutdown(graceMs = 25000) {
    if (shuttingDown) return
    shuttingDown = true
    for (const c of activePolling.values()) c.abort()
    await Promise.race([
      Promise.allSettled([...inFlight]),
      sleep(graceMs),
    ])
    await fastify.close()
  }

  return { fastify, rehydratePendingExecutions, shutdown, _pending: pending }
}
