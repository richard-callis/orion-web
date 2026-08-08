import axios, { AxiosInstance } from 'axios'

interface ToolExecution {
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
  reviewDecision?: string
  reviewedAt?: Date
  expiresAt?: Date
  completedAt?: Date
}

export class OrionClient {
  private client: AxiosInstance
  private gatewayToken: string

  constructor(baseURL: string, executorToken: string, gatewayToken: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        'x-executor-token': executorToken,
      },
    })
    this.gatewayToken = gatewayToken
  }

  async createExecution(data: {
    executionId: string
    tool: string
    args: Record<string, unknown>
    actorId: string
    actorType: 'agent' | 'human'
    status: string
  }): Promise<ToolExecution> {
    const response = await this.client.post('/api/executions', data)
    return response.data
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
    // /api/chatrooms/[id]/messages (note: no hyphen — was previously "/api/chat-rooms/...",
    // a 404) is a session-or-gateway-authenticated route, not one of the x-executor-token
    // paths (only /api/executions accepts that header). Authenticate this call with the
    // gateway Bearer token instead — the route only allows senderType:"system" for
    // gateway-authenticated callers.
    await this.client.post(`/api/chatrooms/${encodeURIComponent(roomId)}/messages`, {
      content: message,
      senderType: 'system',
    }, {
      headers: { Authorization: `Bearer ${this.gatewayToken}` },
    })
  }

  async getSystemSetting(key: string): Promise<string | null> {
    // Same auth gap as notifyRoom: non-public keys require requireServiceAuth (session-or-
    // gateway), which x-executor-token does not satisfy — /api/system-settings isn't in the
    // x-executor-token-scoped path list. Send the gateway Bearer token, same as notifyRoom.
    try {
      const response = await this.client.get(`/api/system-settings/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${this.gatewayToken}` },
      })
      return response.data?.value
    } catch (error) {
      console.error(`Failed to get system setting ${key}:`, error)
      return null
    }
  }
}
