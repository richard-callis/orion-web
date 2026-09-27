import { validateExecutorToken } from './auth.js'
import { classifier } from './classifier.js'
import { redactor } from './redactor.js'
import { sandbox } from './sandbox.js'
import { OrionClient } from './orion-client.js'
import { VectorClient } from './vector-client.js'
import { buildApp } from './app.js'

const PORT = parseInt(process.env.PORT || '3200')
const ORION_URL = process.env.ORION_URL || 'http://orion:3000'
const ORION_EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''
const VECTOR_WEBHOOK_URL = process.env.VECTOR_WEBHOOK_URL || ''
const HOST_AGENT_WEBHOOK_SECRET = process.env.HOST_AGENT_WEBHOOK_SECRET || ''
const EXECUTION_APPROVE_TIMEOUT_SECONDS = parseInt(process.env.EXECUTION_APPROVE_TIMEOUT_SECONDS || '90')
const EXECUTION_ESCALATE_TTL_SECONDS = parseInt(process.env.EXECUTION_ESCALATE_TTL_SECONDS || '3600')
const SHUTDOWN_GRACE_MS = parseInt(process.env.EXECUTOR_SHUTDOWN_GRACE_MS || '25000')

if (!ORION_EXECUTOR_TOKEN) {
  throw new Error('ORION_EXECUTOR_TOKEN environment variable not set')
}

const { fastify, rehydratePendingExecutions, shutdown } = buildApp({
  orion: new OrionClient(ORION_URL, ORION_EXECUTOR_TOKEN),
  events: new VectorClient(VECTOR_WEBHOOK_URL, HOST_AGENT_WEBHOOK_SECRET),
  sandbox,
  classifier,
  redactor,
  validateToken: validateExecutorToken,
  approveTimeoutSeconds: EXECUTION_APPROVE_TIMEOUT_SECONDS,
  escalateTtlSeconds: EXECUTION_ESCALATE_TTL_SECONDS,
  logger: true,
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    fastify.log.info(`${signal} received — draining in-flight executions`)
    shutdown(SHUTDOWN_GRACE_MS)
      .then(() => process.exit(0))
      .catch(err => {
        fastify.log.error({ err }, 'Shutdown failed')
        process.exit(1)
      })
  })
}

process.on('unhandledRejection', err => {
  fastify.log.error({ err }, 'Unhandled promise rejection')
})

fastify.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  fastify.log.info(`Executor listening at ${address}`)

  // Pending rows left by a previous process can't be run (their original arguments were only
  // held in that process's memory), so they are denied here.
  await rehydratePendingExecutions()
})
