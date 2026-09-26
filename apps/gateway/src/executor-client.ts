const EXECUTOR_URL = (process.env.ORION_EXECUTOR_URL || 'http://orion-executor:3200').replace(/\/+$/, '')
const EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''
const REQUEST_TIMEOUT_MS = 120_000
/** How long a tool call waits for an approval decision before handing back "pending". */
const POLL_TIMEOUT_MS = parseInt(process.env.EXECUTOR_POLL_TIMEOUT_MS ?? '100000', 10)
const POLL_INTERVAL_MS = 500
const MAX_CONSECUTIVE_POLL_ERRORS = 5

interface ExecutionRequest {
  tool: 'shell_exec' | 'file_read' | 'system_info'
  args: Record<string, unknown>
  actorId: string
  actorType: 'agent' | 'human'
  executionId: string
}

interface ExecutionResponse {
  executionId: string
  status: string
  output?: string
  message?: string
  error?: string
  /** Present on pending responses: seconds until the approval request expires. */
  expiresInSeconds?: number
}

interface ToolExecution {
  id: string
  executionId: string
  status: string
  output?: string
  exitCode?: number
  durationMs?: number
  reviewDecision?: string
}

class ExecutorHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

class ExecutorClient {
  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${EXECUTOR_URL}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'x-executor-token': EXECUTOR_TOKEN,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`Executor error: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ExecutorHttpError(res.status, `Executor error: HTTP ${res.status}${text ? ` ${text.slice(0, 500)}` : ''}`)
    }
    return (await res.json()) as T
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    let result: ExecutionResponse
    try {
      result = await this.request<ExecutionResponse>('/execute', { method: 'POST', body: request })
    } catch (err) {
      // The executor refuses to re-run an executionId it has already seen.
      if (err instanceof ExecutorHttpError && err.status === 409) {
        return {
          executionId: request.executionId,
          status: 'failed',
          error: `Execution ${request.executionId} was already submitted; the executor refused to run it again`,
        }
      }
      throw err
    }

    // If status is pending (awaiting approval), poll until complete
    if (result.status === 'pending' && result.executionId) {
      return this.pollUntilComplete(result.executionId, result.expiresInSeconds)
    }
    return result
  }

  /**
   * Wait for an approval decision. Never waits past the execution's own expiry
   * (`expiresInSeconds`, up to 3600s for escalations), and never blocks a tool
   * call longer than EXECUTOR_POLL_TIMEOUT_MS; after that the call returns
   * "pending" with the execution id so the caller can check back later.
   */
  private async pollUntilComplete(executionId: string, expiresInSeconds?: number): Promise<ExecutionResponse> {
    const expiryMs = typeof expiresInSeconds === 'number' && expiresInSeconds > 0 ? expiresInSeconds * 1000 : Infinity
    const deadline = Date.now() + Math.min(POLL_TIMEOUT_MS, expiryMs)
    const expiresAt = Number.isFinite(expiryMs) ? new Date(Date.now() + expiryMs).toISOString() : undefined
    let consecutiveErrors = 0

    while (Date.now() < deadline) {
      try {
        const execution = await this.request<ToolExecution>(`/executions/${encodeURIComponent(executionId)}`)
        consecutiveErrors = 0

        if (execution.status === 'completed') {
          return { executionId, status: 'completed', output: execution.output }
        }
        if (execution.status === 'failed' || execution.status === 'denied') {
          return {
            executionId,
            status: execution.status,
            error: execution.output || `Execution ${execution.status}`,
          }
        }
      } catch (error) {
        if (error instanceof ExecutorHttpError && error.status === 404) {
          throw new Error(`Execution not found: ${executionId}`)
        }
        // Tolerate transient executor/network blips instead of failing the call.
        if (++consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw error
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    // Approval can legitimately take longer than one tool call. Report the
    // execution as still pending rather than as a failure so the caller does
    // not assume it will never run.
    return {
      executionId,
      status: 'pending',
      expiresInSeconds,
      error: `Execution ${executionId} is still awaiting approval; it will run once approved` +
        (expiresAt ? ` (the request expires at ${expiresAt})` : '') + '. Check its status later.',
    }
  }

  /**
   * Record a human review decision. `reviewerId` is the human who decided; the
   * executor rejects approval by the requesting actor.
   */
  async approve(executionId: string, reason: string, reviewerId: string): Promise<void> {
    if (!reviewerId) throw new Error('approve requires reviewerId')
    await this.request(`/executions/${encodeURIComponent(executionId)}/review`, {
      method: 'POST',
      body: { decision: 'approved', reason, reviewerId },
    })
  }

  async deny(executionId: string, reason: string, reviewerId: string): Promise<void> {
    if (!reviewerId) throw new Error('deny requires reviewerId')
    await this.request(`/executions/${encodeURIComponent(executionId)}/review`, {
      method: 'POST',
      body: { decision: 'denied', reason, reviewerId },
    })
  }
}

export const executorClient = new ExecutorClient()
