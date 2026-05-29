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
  completedAt?: Date
}

export class OrionClient {
  private client: AxiosInstance

  constructor(baseURL: string, token: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        'x-executor-token': token,
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

  async notifyRoom(roomId: string, message: string): Promise<void> {
    await this.client.post(`/api/chat-rooms/${roomId}/messages`, {
      content: message,
      senderType: 'system',
    })
  }
}
