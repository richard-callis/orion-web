import type { GatewayTool } from './types'

/**
 * Lightweight HTTP client for the gateway's REST tool API.
 * Used by agent runners that can't speak MCP natively (Ollama, Gemini).
 */
export class GatewayClient {
  constructor(private url: string, private token: string) {}

  private headers() {
    return { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' }
  }

  async listTools(): Promise<GatewayTool[]> {
    const res = await fetch(`${this.url}/tools`, { headers: this.headers() })
    if (!res.ok) throw new Error(`Gateway listTools failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.url}/tools/execute`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, arguments: args }),
    })
    const data = await res.json() as { result?: string; error?: string }
    if (!res.ok || data.error) throw new Error(data.error ?? `Tool ${name} failed: ${res.status}`)
    return data.result ?? ''
  }
}
