import Fastify, { FastifyRequest, FastifyReply } from 'fastify'
import fastifyCors from 'fastify-cors'
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

if (!ORION_EXECUTOR_TOKEN) {
  throw new Error('ORION_EXECUTOR_TOKEN environment variable not set')
}

const fastify = Fastify({ logger: true })
const orionClient = new OrionClient(ORION_URL, ORION_GATEWAY_TOKEN)
const vectorClient = new VectorClient(VECTOR_WEBHOOK_URL, HOST_AGENT_WEBHOOK_SECRET)

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
    try {
      const result = await sandbox.execute(tool, args, {
        timeoutMs: 30000,
      })

      const output = redactor.redactOutput(result.stdout + result.stderr)
      await orionClient.updateExecution(execution.id, {
        status: 'completed',
        output,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        completedAt: new Date(),
      })

      await vectorClient.emit({
        executionId: execution.id,
        tool,
        actorId,
        actorType,
        riskTier,
        status: 'completed',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      })

      return { executionId: execution.id, status: 'completed', output }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      await orionClient.updateExecution(execution.id, {
        status: 'failed',
        output: errorMsg,
        completedAt: new Date(),
      })

      await vectorClient.emit({
        executionId: execution.id,
        tool,
        actorId,
        actorType,
        riskTier,
        status: 'failed',
      })

      reply.status(500).send({ error: errorMsg })
    }
  } else {
    // Approval/escalation pending — will be gated by Warden
    return { executionId: execution.id, status: 'pending', message: 'Awaiting approval' }
  }
})

fastify.get<{
  Params: { id: string }
}>('/executions/:id', async (request, reply) => {
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

  if (decision === 'denied') {
    await orionClient.updateExecution(id, {
      status: 'denied',
      reviewDecision: 'denied',
      reviewedAt: new Date(),
    })
    return { status: 'denied' }
  }

  if (decision === 'approved') {
    // Execution is approved — execute now
    const execution = await orionClient.getExecution(id)
    try {
      const result = await sandbox.execute(execution.tool, execution.args, {
        timeoutMs: 30000,
      })

      const output = redactor.redactOutput(result.stdout + result.stderr)
      await orionClient.updateExecution(id, {
        status: 'completed',
        output,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        reviewDecision: 'approved',
        reviewedAt: new Date(),
        completedAt: new Date(),
      })

      await vectorClient.emit({
        executionId: id,
        tool: execution.tool,
        actorId: execution.actorId,
        actorType: execution.actorType,
        riskTier: execution.riskTier,
        status: 'completed',
        reviewDecision: 'approved',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      })

      return { status: 'completed', output }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      await orionClient.updateExecution(id, {
        status: 'failed',
        output: errorMsg,
        reviewDecision: 'approved',
        reviewedAt: new Date(),
        completedAt: new Date(),
      })

      reply.status(500).send({ error: errorMsg })
    }
  }
})

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  fastify.log.info(`Executor listening at ${address}`)
})
