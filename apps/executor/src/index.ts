import Fastify, { FastifyRequest, FastifyReply } from 'fastify'
import fastifyCors from '@fastify/cors'
import { validateExecutorToken } from './auth.js'
import { classifier } from './classifier.js'
import { redactor } from './redactor.js'
import { sandbox } from './sandbox.js'
import { OrionClient } from './orion-client.js'
import { VectorClient } from './vector-client.js'

const PORT = parseInt(process.env.PORT || '3200')
const ORION_URL = process.env.ORION_URL || 'http://orion:3000'
const ORION_EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''
const ORION_GATEWAY_TOKEN = process.env.ORION_GATEWAY_TOKEN || ''
const VECTOR_WEBHOOK_URL = process.env.VECTOR_WEBHOOK_URL || ''
const HOST_AGENT_WEBHOOK_SECRET = process.env.HOST_AGENT_WEBHOOK_SECRET || ''
const EXECUTION_APPROVE_TIMEOUT_SECONDS = parseInt(process.env.EXECUTION_APPROVE_TIMEOUT_SECONDS || '90')
const EXECUTION_ESCALATE_TTL_SECONDS = parseInt(process.env.EXECUTION_ESCALATE_TTL_SECONDS || '3600')

if (!ORION_EXECUTOR_TOKEN) {
  throw new Error('ORION_EXECUTOR_TOKEN environment variable not set')
}

const fastify = Fastify({ logger: true })
const orionClient = new OrionClient(ORION_URL, ORION_GATEWAY_TOKEN)
const vectorClient = new VectorClient(VECTOR_WEBHOOK_URL, HOST_AGENT_WEBHOOK_SECRET)

// Track active polling tasks — key: executionId, value: AbortController
const activePolling = new Map<string, AbortController>()

fastify.register(fastifyCors)

// Auth middleware for protected routes
const requireExecutorToken = async (request: FastifyRequest, reply: FastifyReply) => {
  const token = request.headers['x-executor-token'] as string
  if (!validateExecutorToken(token)) {
    reply.status(401).send({ error: 'Unauthorized' })
  }
}

fastify.get('/health', async (request, reply) => {
  return { status: 'ok' }
})

async function executeCommand(
  executionId: string,
  tool: string,
  args: Record<string, unknown>,
  actorId: string,
  actorType: 'agent' | 'human'
): Promise<{ status: string; output?: string; error?: string }> {
  try {
    const result = await sandbox.execute(tool, args, {
      timeoutMs: 30000,
    })

    const output = redactor.redactOutput(result.stdout + result.stderr)
    await orionClient.updateExecution(executionId, {
      status: 'completed',
      output,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      completedAt: new Date(),
    })

    await vectorClient.emit({
      executionId,
      tool,
      actorId,
      actorType,
      riskTier: 'auto',
      status: 'completed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })

    return { status: 'completed', output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    await orionClient.updateExecution(executionId, {
      status: 'failed',
      output: errorMsg,
      completedAt: new Date(),
    })

    await vectorClient.emit({
      executionId,
      tool,
      actorId,
      actorType,
      riskTier: 'auto',
      status: 'failed',
    })

    return { status: 'failed', error: errorMsg }
  }
}

async function pollForApproval(
  executionId: string,
  execution: any,
  timeoutSeconds: number,
  autoApproveIfEscalate: boolean = false
): Promise<void> {
  const controller = new AbortController()
  activePolling.set(executionId, controller)

  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000

  try {
    while (!controller.signal.aborted) {
      const current = await orionClient.getExecution(executionId)

      // Check if decision was made
      if (current.reviewDecision) {
        activePolling.delete(executionId)

        if (current.reviewDecision === 'approved') {
          // Execute the approved command
          const result = await executeCommand(
            executionId,
            execution.tool,
            execution.args,
            execution.actorId,
            execution.actorType
          )

          await vectorClient.emit({
            executionId,
            tool: execution.tool,
            actorId: execution.actorId,
            actorType: execution.actorType,
            riskTier: execution.riskTier,
            status: result.status,
            reviewDecision: 'approved',
            exitCode: result.status === 'completed' ? 0 : 1,
          })
        }
        return
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        activePolling.delete(executionId)

        // Auto-deny
        await orionClient.updateExecution(executionId, {
          status: 'denied',
          reviewDecision: 'denied',
          reviewedAt: new Date(),
          completedAt: new Date(),
        })

        await vectorClient.emit({
          executionId,
          tool: execution.tool,
          actorId: execution.actorId,
          actorType: execution.actorType,
          riskTier: execution.riskTier,
          status: 'denied',
          reviewDecision: 'denied',
        })

        // Notify execution room of timeout
        try {
          const roomSetting = await orionClient.getSystemSetting('system.room.execution')
          if (roomSetting) {
            await orionClient.notifyRoom(
              roomSetting,
              `⏱ Execution ${executionId} auto-denied after ${timeoutSeconds}s timeout`
            )
          }
        } catch (err) {
          fastify.log.error(`Failed to notify timeout: ${err}`)
        }

        return
      }

      // Poll every 2 seconds
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  } catch (error) {
    fastify.log.error({ err: error }, `Polling error for ${executionId}`)
    activePolling.delete(executionId)
  }
}

fastify.post<{
  Body: {
    tool: 'shell_exec' | 'file_read' | 'system_info'
    args: Record<string, unknown>
    actorId: string
    actorType: 'agent' | 'human'
    executionId: string
  }
}>('/execute', { onRequest: requireExecutorToken }, async (request, reply) => {
  const { tool, args, actorId, actorType, executionId } = request.body

  // Log intent to Orion
  const execution = await orionClient.createExecution({
    executionId,
    tool,
    args: redactor.redactArgs(args),
    actorId,
    actorType,
    status: 'pending',
  })

  // Classify risk
  const riskTier = classifier.classify(tool, args)

  // Update with risk tier
  await orionClient.updateExecution(execution.id, {
    riskTier,
    status: riskTier === 'auto' ? 'running' : 'pending',
  })

  if (riskTier === 'auto') {
    // Execute immediately
    const result = await executeCommand(executionId, tool, args, actorId, actorType)
    return { executionId: execution.id, ...result }
  } else {
    // Approval/escalation pending — notify Warden
    const timeoutSeconds = riskTier === 'escalate' ? EXECUTION_ESCALATE_TTL_SECONDS : EXECUTION_APPROVE_TIMEOUT_SECONDS

    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000)
    await orionClient.updateExecution(execution.id, { expiresAt })

    // Post notification to execution room
    try {
      const roomSetting = await orionClient.getSystemSetting('system.room.execution')
      if (roomSetting) {
        const action = riskTier === 'escalate' ? 'ESCALATE' : 'APPROVE'
        await orionClient.notifyRoom(
          roomSetting,
          `⚡ EXECUTION REQUEST [${riskTier}]\n  ID: ${executionId}\n  Tool: ${tool}\n  Actor: ${actorId} (${actorType})\n  Risk Tier: ${riskTier}\n\nCall approve_execution("${executionId}", reason) or deny_execution("${executionId}", reason)`
        )
      }
    } catch (err) {
      fastify.log.error(`Failed to notify execution room: ${err}`)
    }

    // Start polling for approval in background
    pollForApproval(execution.id, execution, timeoutSeconds).catch(err => {
      fastify.log.error(`Polling error: ${err}`)
    })

    return { executionId: execution.id, status: 'pending', message: `Awaiting ${riskTier} decision` }
  }
})

fastify.get<{
  Params: { id: string }
}>('/executions/:id', { onRequest: requireExecutorToken }, async (request, reply) => {
  const { id } = request.params
  const execution = await orionClient.getExecution(id)
  return execution
})

fastify.post<{
  Params: { id: string }
  Body: {
    decision: 'approved' | 'denied'
    reason: string
  }
}>('/executions/:id/review', { onRequest: requireExecutorToken }, async (request, reply) => {
  const { id } = request.params
  const { decision, reason } = request.body

  const execution = await orionClient.getExecution(id)

  if (decision === 'denied') {
    await orionClient.updateExecution(id, {
      status: 'denied',
      reviewDecision: 'denied',
      reviewedAt: new Date(),
      completedAt: new Date(),
    })
    return { status: 'denied' }
  }

  if (decision === 'approved') {
    // Mark as approved
    await orionClient.updateExecution(id, {
      reviewDecision: 'approved',
      reviewedAt: new Date(),
    })
    // Polling task will execute and complete the record
    return { status: 'processing' }
  }
})

// Startup: rehydrate pending executions
async function rehydratePendingExecutions() {
  try {
    fastify.log.info('Rehydrating pending executions...')
    const pending = await orionClient.listExecutions({ status: 'pending' })
    const now = Date.now()
    let resumed = 0
    let autoDenied = 0

    for (const exec of pending) {
      if (exec.expiresAt && new Date(exec.expiresAt as unknown as string).getTime() <= now) {
        // Expired — auto-deny immediately
        await orionClient.updateExecution(exec.id, {
          status: 'denied',
          reviewDecision: 'denied',
          reviewedAt: new Date(),
          completedAt: new Date(),
        })
        try {
          const roomId = await orionClient.getSystemSetting('system.room.execution')
          if (roomId) {
            await orionClient.notifyRoom(roomId, `⏱ Execution ${exec.executionId} auto-denied on restart — TTL expired`)
          }
        } catch { /* best-effort notify */ }
        autoDenied++
      } else {
        // Still valid — resume polling
        const remainingSeconds = exec.expiresAt
          ? Math.ceil((new Date(exec.expiresAt as unknown as string).getTime() - now) / 1000)
          : EXECUTION_APPROVE_TIMEOUT_SECONDS
        pollForApproval(exec.id, exec, remainingSeconds).catch(err => {
          fastify.log.error(`Rehydration polling error for ${exec.id}: ${err}`)
        })
        resumed++
      }
    }

    fastify.log.info(`Rehydration complete — resumed: ${resumed}, auto-denied: ${autoDenied}`)
  } catch (error) {
    fastify.log.error({ err: error }, 'Rehydration failed')
  }
}

fastify.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  fastify.log.info(`Executor listening at ${address}`)

  // Rehydrate on startup
  await rehydratePendingExecutions()
})
