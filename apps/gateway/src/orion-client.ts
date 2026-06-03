/**
 * Client for talking to ORION.
 * Handles registration, heartbeat, and fetching tool config.
 */

export interface McpToolConfig {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execType: string
  execConfig: Record<string, unknown> | null
  enabled: boolean
  builtIn: boolean
}

interface GatewayConfig {
  mccUrl: string        // e.g. http://orion.management.svc.cluster.local
  environmentId: string
  gatewayToken: string
  gatewayUrl: string    // this gateway's own URL, reported to ORION
}

export class OrionClient {
  private cfg: GatewayConfig
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.cfg.gatewayToken}`,
    }
  }

  async register(version?: string): Promise<void> {
    const res = await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ status: 'connected', gatewayUrl: this.cfg.gatewayUrl, lastSeen: new Date().toISOString(), gatewayVersion: version }),
    })
    if (!res.ok) throw new Error(`Failed to register with ORION: ${res.status} ${await res.text()}`)
    console.log(`[gateway] Registered with ORION as environment ${this.cfg.environmentId}`)
  }

  async disconnect(): Promise<void> {
    await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ status: 'disconnected' }),
    }).catch(() => {})
  }

  async fetchTools(): Promise<McpToolConfig[]> {
    const res = await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}/tools?enabled=true`, {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Failed to fetch tools: ${res.status}`)
    return res.json()
  }

  /** Start sending heartbeats every 30s so ORION knows we're alive */
  startHeartbeat(onToolsChanged: (tools: McpToolConfig[]) => void, intervalMs = 30_000, version?: string) {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}`, {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({ status: 'connected', lastSeen: new Date().toISOString(), gatewayVersion: version }),
        })
        // Refresh tool config on every heartbeat so changes take effect within one interval
        const tools = await this.fetchTools()
        onToolsChanged(tools)
      } catch (err) {
        console.error('[gateway] Heartbeat failed:', err)
      }
    }, intervalMs)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  /** Report K8s Ingress rules to ORION for display in the Ingress management page */
  async reportIngresses(ingresses: import('./ingress-watcher.js').K8sIngressRule[]): Promise<void> {
    const res = await fetch(
      `${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}/ingress/sync`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ingresses }),
      },
    )
    if (!res.ok) {
      console.error(`[gateway] reportIngresses failed: ${res.status} ${await res.text()}`)
    }
  }

  /** Report ArgoCD Application sync/health state to ORION */
  async reportSyncStatus(apps: import('./argocd-watcher.js').ArgoCDApp[]): Promise<void> {
    const res = await fetch(
      `${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}/sync-status`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ applications: apps }),
      },
    )
    if (!res.ok) {
      console.error(`[gateway] reportSyncStatus failed: ${res.status} ${await res.text()}`)
    }
  }

  /** Fetch active NebulaInstances (skills + hooks) for an environment */
  async fetchNebula(environmentId: string): Promise<unknown[]> {
    const res = await fetch(
      `${this.cfg.mccUrl}/api/environments/${environmentId}/nebula/active`,
      { headers: this.headers() },
    )
    if (!res.ok) throw new Error(`Failed to fetch nebula: ${res.status}`)
    return res.json()
  }

  /** Report hook execution result back to ORION */
  async reportHookExecution(
    environmentId: string,
    data: {
      nebulaId: string
      triggerEvent: string
      triggerData?: string
      actionType: string
      status: string
      output?: string
      startedAt?: string | Date
      durationMs?: number
    },
  ): Promise<void> {
    const res = await fetch(
      `${this.cfg.mccUrl}/api/environments/${environmentId}/nebula/hook/report`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(data),
      },
    )
    if (!res.ok) {
      console.error(`[gateway] reportHookExecution failed: ${res.status}`)
    }
  }

  /** Redact sensitive patterns from tool args/results before transmitting. */
  private redactForTrace(value: string | undefined): string | undefined {
    if (!value) return value
    const MAX_LEN = 4096
    let redacted = value
      .replace(/([A-Za-z0-9+/]{40,}={0,2})/g, (m) => m.length > 60 ? '[REDACTED_BASE64]' : m) // long base64
      .replace(/\b(mcg|mcga|ghp|ghs|glpat)_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]') // PATs
      .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
      .replace(/password["\s:=]+[^\s"]{8,}/gi, 'password=[REDACTED]')
    if (redacted.length > MAX_LEN) redacted = redacted.slice(0, MAX_LEN) + '[TRUNCATED]'
    return redacted
  }

  /** Report an AgentTrace to ORION */
  async reportTrace(data: {
    conversationId?: string
    taskId?: string
    step: number
    type: string
    toolName?: string
    toolArgs?: string
    toolResult?: string
    content?: string
    skillName?: string
    hookName?: string
    durationMs?: number
    modelUsed?: string
    systemPromptHash?: string
    tokensIn?: number
    tokensOut?: number
    costCents?: number
  }): Promise<void> {
    const res = await fetch(
      `${this.cfg.mccUrl}/api/observability/trace`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ...data,
          toolArgs:   this.redactForTrace(data.toolArgs),
          toolResult: this.redactForTrace(data.toolResult),
          content:    this.redactForTrace(data.content),
        }),
      },
    )
    if (!res.ok) {
      console.error(`[gateway] reportTrace failed: ${res.status}`)
    }
  }
}
