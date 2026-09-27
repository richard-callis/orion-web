import type { GatewayTool } from './types'
import { runSignal } from './abort'
import { gatewayHeaders, SYSTEM_ACTOR, type GatewayActor } from '../gateway-headers'

/**
 * Lightweight HTTP client for the gateway's REST tool API.
 * Used by agent runners that can't speak MCP natively (Ollama, Gemini).
 */
export class GatewayClient {
  constructor(private url: string, private token: string, private actor: GatewayActor = SYSTEM_ACTOR) {}

  private headers() {
    return gatewayHeaders(this.token, this.actor)
  }

  async listTools(signal?: AbortSignal): Promise<GatewayTool[]> {
    const res = await fetch(`${this.url}/tools`, { headers: this.headers(), signal: runSignal(signal, 30_000) })
    if (!res.ok) throw new Error(`Gateway listTools failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async executeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.url}/tools/execute`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, arguments: args }),
      // Per-tool-call timeout — a hung gateway would previously block the entire
      // agent turn indefinitely (no signal on the fetch). 120s covers slow ops
      // (kubectl rollout, helm install) without blocking forever on a dead gateway.
      signal: runSignal(signal, 120_000),
    })
    const data = await res.json() as { result?: string; error?: string }
    if (!res.ok || data.error) throw new Error(data.error ?? `Tool ${name} failed: ${res.status}`)
    return data.result ?? ''
  }
}
