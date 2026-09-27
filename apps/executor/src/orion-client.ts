import axios, { AxiosInstance } from 'axios'

export interface ToolExecution {
  id: string
  executionId: string
  tool: string
  args: Record<string, unknown>
  actorId: string
  actorType: 'agent' | 'human'
  riskTier?: string
  status: string
  output?: string
  exitCode?: number
  durationMs?: number
  reviewDecision?: string | null
  reviewerId?: string | null
  reviewedAt?: Date
  expiresAt?: Date | string | null
  createdAt?: Date | string
  completedAt?: Date
}

export class OrionClient {
  private client: AxiosInstance

  // H2: the executor holds only ORION_EXECUTOR_TOKEN. ORION accepts it for exactly
  // the calls below (apps/web/src/lib/executor-scope.ts) — never the gateway token,
  // which is readable from inside the executor by any command it runs.
  constructor(baseURL: string, executorToken: string) {
    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'x-executor-token': executorToken,
      },
    })
  }

  async createExecution(data: {
    executionId: string
    tool: string
    args: Record<string, unknown>
    actorId: string
    actorType: 'agent' | 'human'
    status: string
  }): Promise<{ execution: ToolExecution; created: boolean }> {
    // ORION answers 201 for a new row and 200 with the EXISTING row when executionId was seen
    // before. The caller must never run a command for a row it didn't just create.
    const response = await this.client.post('/api/executions', data)
    return { execution: response.data, created: response.status === 201 }
  }

  async getExecution(id: string): Promise<ToolExecution> {
    const response = await this.client.get(`/api/executions/${encodeURIComponent(id)}`)
    return response.data
  }

  async updateExecution(
    id: string,
    data: Partial<ToolExecution>
  ): Promise<ToolExecution> {
    const response = await this.client.patch(`/api/executions/${encodeURIComponent(id)}`, data)
    return response.data
  }

  async listExecutions(params: { status?: string } = {}): Promise<ToolExecution[]> {
    const query = params.status ? `?status=${encodeURIComponent(params.status)}` : ''
    const response = await this.client.get(`/api/executions${query}`)
    if (!Array.isArray(response.data)) {
      throw new Error(`listExecutions: expected array, got ${typeof response.data} — possible auth failure`)
    }
    return response.data
  }

  async notifyRoom(roomId: string, message: string): Promise<void> {
    // ORION only accepts this for the configured execution room.
    await this.client.post(`/api/chatrooms/${encodeURIComponent(roomId)}/messages`, {
      content: message,
      senderType: 'system',
    })
  }

  async getSystemSetting(key: string): Promise<string | null> {
    // ORION only lets the executor token read 'system.room.execution'.
    try {
      const response = await this.client.get(`/api/system-settings/${encodeURIComponent(key)}`)
      return response.data?.value
    } catch (error) {
      console.error(`Failed to get system setting ${key}:`, error)
      return null
    }
  }
}
