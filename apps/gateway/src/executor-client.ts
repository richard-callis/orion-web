import axios, { AxiosInstance } from 'axios'

const EXECUTOR_URL = process.env.ORION_EXECUTOR_URL || 'http://orion-executor:3200'
const EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''

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

class ExecutorClient {
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: EXECUTOR_URL,
      headers: {
        'x-executor-token': EXECUTOR_TOKEN,
      },
      timeout: 120000,
    })
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    try {
      const response = await this.client.post('/execute', request)
      const result = response.data as ExecutionResponse

      // If status is pending (awaiting approval), poll until complete
      if (result.status === 'pending' && result.executionId) {
        return await this.pollUntilComplete(result.executionId)
      }

      return result
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Executor error: ${error.message}`)
      }
      throw error
    }
  }

  private async pollUntilComplete(executionId: string): Promise<ExecutionResponse> {
    const maxAttempts = 200 // 200 * 500ms = 100s timeout
    let attempts = 0

    while (attempts < maxAttempts) {
      try {
        const response = await this.client.get(`/executions/${executionId}`)
        const execution = response.data as ToolExecution

        if (execution.status === 'completed') {
          return {
            executionId,
            status: 'completed',
            output: execution.output,
          }
        }

        if (execution.status === 'failed' || execution.status === 'denied') {
          return {
            executionId,
            status: execution.status,
            error: execution.output || `Execution ${execution.status}`,
          }
        }

        // Still pending, wait before next poll
        await new Promise(resolve => setTimeout(resolve, 500))
        attempts++
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          throw new Error(`Execution not found: ${executionId}`)
        }
        throw error
      }
    }

    throw new Error(`Execution polling timeout for ${executionId}`)
  }

  async approve(executionId: string, reason: string): Promise<void> {
    await this.client.post(`/executions/${executionId}/review`, {
      decision: 'approved',
      reason,
    })
  }

  async deny(executionId: string, reason: string): Promise<void> {
    await this.client.post(`/executions/${executionId}/review`, {
      decision: 'denied',
      reason,
    })
  }
}

export const executorClient = new ExecutorClient()
