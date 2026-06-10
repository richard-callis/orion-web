/**
 * Lightweight Langfuse client using the public HTTP ingestion API.
 * Enabled when LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are set.
 * LANGFUSE_HOST defaults to https://cloud.langfuse.com but can be overridden
 * for self-hosted deployments.
 *
 * Docs: https://api.reference.langfuse.com
 */

const LANGFUSE_HOST       = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY

function isEnabled(): boolean {
  return !!(LANGFUSE_SECRET_KEY && LANGFUSE_PUBLIC_KEY)
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')
}

async function ingest(batch: object[]): Promise<void> {
  if (!isEnabled() || batch.length === 0) return
  await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {}) // never throw — tracing must be non-blocking
}

export interface LangfuseTrace {
  traceId: string
  flush(): Promise<void>
  startSpan(name: string, input?: unknown): string // returns spanId
  endSpan(spanId: string, output?: unknown, statusMessage?: string): void
  recordGeneration(opts: {
    spanId?: string
    model: string
    input: string
    output: string
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
  }): void
  complete(output?: string): void
}

export function createTrace(opts: {
  taskId: string
  taskTitle: string
  agentId: string
  modelId: string
}): LangfuseTrace {
  const traceId = opts.taskId
  const events: object[] = []
  const now = () => new Date().toISOString()

  // Create the trace
  events.push({
    id: crypto.randomUUID(),
    type: 'trace-create',
    timestamp: now(),
    body: {
      id: traceId,
      name: opts.taskTitle,
      metadata: { agentId: opts.agentId, modelId: opts.modelId },
    },
  })

  return {
    traceId,

    startSpan(name: string, input?: unknown): string {
      const spanId = crypto.randomUUID()
      events.push({
        id: crypto.randomUUID(),
        type: 'span-create',
        timestamp: now(),
        body: { id: spanId, traceId, name, startTime: now(), input },
      })
      return spanId
    },

    endSpan(spanId: string, output?: unknown, statusMessage?: string): void {
      events.push({
        id: crypto.randomUUID(),
        type: 'span-update',
        timestamp: now(),
        body: { id: spanId, traceId, endTime: now(), output, statusMessage },
      })
    },

    recordGeneration(opts): void {
      events.push({
        id: crypto.randomUUID(),
        type: 'generation-create',
        timestamp: now(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          parentObservationId: opts.spanId,
          name: 'llm',
          startTime: now(),
          endTime: now(),
          model: opts.model,
          input: opts.input,
          output: opts.output,
          usage: {
            input:  opts.inputTokens ?? 0,
            output: opts.outputTokens ?? 0,
            total:  (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
          },
          metadata: { durationMs: opts.durationMs },
        },
      })
    },

    complete(output?: string): void {
      events.push({
        id: crypto.randomUUID(),
        type: 'trace-create',
        timestamp: now(),
        body: { id: traceId, output },
      })
    },

    async flush(): Promise<void> {
      await ingest(events)
      events.length = 0
    },
  }
}
