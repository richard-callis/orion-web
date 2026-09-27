/**
 * Client-safe view of an Environment row.
 *
 * Environment rows carry credentials (gateway token, kubeconfig, federation
 * token, talosconfig in metadata) and are often loaded with their linked
 * agents (which carry mcpToken). None of that may reach the browser. The UI
 * only needs to know whether each credential is set, so each secret is
 * replaced by a `hasX` flag.
 */

/** Metadata keys that hold credentials and must never be returned. */
const SECRET_METADATA_KEYS = ['talosConfig'] as const

/**
 * Legacy mask value. Older UI builds (and the gateway heartbeat response)
 * used it as a "leave unchanged" sentinel, so writes still treat it that way.
 */
export const SECRET_MASK = '••••'

type SecretFields = {
  gatewayToken?: string | null
  kubeconfig?: string | null
  federationToken?: string | null
  metadata?: unknown
  agents?: Array<{ agent?: Record<string, unknown> | null } & Record<string, unknown>>
}

export type EnvironmentDTO<T> = Omit<T, 'gatewayToken' | 'kubeconfig' | 'federationToken' | 'metadata'> & {
  gatewayToken: null
  kubeconfig: null
  federationToken: null
  metadata: Record<string, unknown> | null
  hasGatewayToken: boolean
  hasKubeconfig: boolean
  hasFederationToken: boolean
  hasTalosConfig: boolean
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function toEnvironmentDTO<T extends SecretFields>(env: T): EnvironmentDTO<T> {
  const meta = asRecord(env.metadata)
  let safeMeta: Record<string, unknown> | null = null
  if (meta) {
    safeMeta = { ...meta }
    for (const k of SECRET_METADATA_KEYS) delete safeMeta[k]
  }

  const out: Record<string, unknown> = {
    ...env,
    gatewayToken: null,
    kubeconfig: null,
    federationToken: null,
    metadata: safeMeta,
    hasGatewayToken: !!env.gatewayToken,
    hasKubeconfig: !!env.kubeconfig,
    hasFederationToken: !!env.federationToken,
    hasTalosConfig: !!meta?.talosConfig,
  }
  if (Array.isArray(env.agents)) {
    out.agents = env.agents.map(link =>
      link.agent ? { ...link, agent: { ...link.agent, mcpToken: null } } : link,
    )
  }
  return out as EnvironmentDTO<T>
}

/** True when a submitted secret means "keep the stored value". */
export function isUnchangedSecret(v: unknown): boolean {
  return v === undefined || v === SECRET_MASK
}

/**
 * Merge submitted metadata over the stored metadata. Credential keys are
 * never returned to the client, so a form that echoes metadata back won't
 * include them: an absent/empty/masked credential key keeps the stored value.
 */
export function mergeEnvironmentMetadata(
  existing: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const prev = asRecord(existing) ?? {}
  const next: Record<string, unknown> = { ...prev, ...incoming }
  for (const k of SECRET_METADATA_KEYS) {
    const v = incoming[k]
    if (v === undefined || v === '' || v === SECRET_MASK) {
      if (prev[k] !== undefined) next[k] = prev[k]
      else delete next[k]
    }
  }
  return next
}
