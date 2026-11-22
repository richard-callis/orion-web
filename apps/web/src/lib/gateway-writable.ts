/**
 * Can this gateway run the writes a bootstrap job needs? It must answer, and for a
 * Kubernetes environment it must offer kubectl_apply_manifest: a read-only gateway
 * (GATEWAY_READ_ONLY) answers reads but has no write tools, and the job would fail
 * halfway. Callers fall back to the environment's stored kubeconfig.
 */
import { gatewayHeaders } from './gateway-headers'

export async function gatewayCanWrite(url: string, token: string, envType: string): Promise<boolean> {
  try {
    const probe = await fetch(`${url}/tools/execute`, {
      method: 'POST',
      headers: gatewayHeaders(token),
      body: JSON.stringify({ name: 'kubectl_get_nodes', arguments: { wide: false } }),
      signal: AbortSignal.timeout(5000),
    })
    if (!probe.ok) return false
    if (envType === 'docker') return true // its jobs use Docker tools
    const res = await fetch(`${url}/tools`, { headers: gatewayHeaders(token), signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const tools: unknown = await res.json()
    return Array.isArray(tools) && tools.some(t => (t as { name?: unknown } | null)?.name === 'kubectl_apply_manifest')
  } catch {
    return false
  }
}
