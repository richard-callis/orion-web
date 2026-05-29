import axios, { AxiosInstance } from 'axios'
import crypto from 'crypto'

interface ExecutionEvent {
  executionId: string
  tool: string
  actorId: string
  actorType: 'agent' | 'human'
  riskTier: string
  status: string
  reviewDecision?: string
  exitCode?: number
  durationMs?: number
  reviewerId?: string
}

export class VectorClient {
  private client: AxiosInstance
  private webhookSecret: string

  constructor(webhookUrl: string, secret: string) {
    this.client = axios.create({
      baseURL: webhookUrl,
    })
    this.webhookSecret = secret
  }

  async emit(event: ExecutionEvent): Promise<void> {
    const payload = {
      source: 'orion-executor',
      event_type: 'tool_execution',
      ...event,
      timestamp: new Date().toISOString(),
    }

    const signature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex')

    try {
      await this.client.post('', payload, {
        headers: {
          'x-webhook-signature': signature,
        },
      })
    } catch (error) {
      console.error('Failed to emit event to Vector:', error)
    }
  }
}
