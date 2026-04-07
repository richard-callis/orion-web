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

  async register(): Promise<void> {
    const res = await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ status: 'connected', gatewayUrl: this.cfg.gatewayUrl, lastSeen: new Date().toISOString() }),
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
  startHeartbeat(onToolsChanged: (tools: McpToolConfig[]) => void, intervalMs = 30_000) {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await fetch(`${this.cfg.mccUrl}/api/environments/${this.cfg.environmentId}`, {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({ lastSeen: new Date().toISOString() }),
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
}
