/**
 * Nebula — Central service catalog (Nova registry).
 *
 * A Nova is a self-contained definition for either:
 *   - An AI Agent (system prompt, tools, context config)
 *   - A service to deploy to the cluster (Helm chart, manifests, config)
 *
 * Sources (merged at runtime):
 *   1. Bundled — shipped in source (from provider-engine.ts BUNDLED_PROVIDERS)
 *   2. Remote — loaded from the orion-nub repo at build time
 *   3. User-created — stored in the database via /api/novas
 */

import { ProviderConfig, BUNDLED_PROVIDERS, getProviderSync, getProvider } from './provider-engine'

// ── Nova types ──────────────────────────────────────────────────────────────────

export type NovaType = 'agent' | 'service'

export type NovaCategory =
  | 'Identity'
  | 'Storage'
  | 'Monitoring'
  | 'DevTools'
  | 'Agent'
  | 'Other'

export interface NovaConfig {
  name: string
  displayName: string
  description: string
  /** 'agent' | 'service' */
  type: NovaType
  /** Helm chart config (for service-type Novas) */
  helm?: ProviderConfig['helm']
  /** Overlay secret config (for service-type Novas) */
  overlaySecret?: ProviderConfig['overlaySecret']
  /** Deployment targets (for service-type Novas) */
  deployments?: ProviderConfig['deployments']
  /** Readiness check config (for service-type Novas) */
  waitForReady?: ProviderConfig['waitForReady']
  /** Cleanup config (for service-type Novas) */
  cleanup?: ProviderConfig['cleanup']
  /** Custom manifests to apply (for service-type Novas) */
  manifests?: string[]
  /** Custom helm values as inline string */
  rawValues?: string
  /** Agent system prompt (for agent-type Novas) */
  systemPrompt?: string
  /** Agent context config (for agent-type Novas) */
  contextConfig?: Record<string, unknown>
}

export interface Nova {
  id: string
  name: string
  displayName: string
  description: string | null
  category: NovaCategory
  version: string
  source: 'bundled' | 'remote' | 'user-created'
  config: NovaConfig
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface NovaListResponse {
  novae: Nova[]
}

export interface NovaCreateRequest {
  name: string
  displayName: string
  description?: string
  category?: NovaCategory
  version?: string
  config: NovaConfig
  tags?: string[]
}

export interface NovaImportResponse {
  agentId?: string
  deploymentId?: string
  message: string
}

// ── Bundled Nova definitions ───────────────────────────────────────────────────

export const BUNDLED_NOVAE: Record<string, Nova> = {}

// Convert ProviderConfig entries to Nova definitions
for (const [key, config] of Object.entries(BUNDLED_PROVIDERS)) {
  BUNDLED_NOVAE[key] = {
    id: `bundled_${key}`,
    name: config.name,
    displayName: config.displayName,
    description: config.description,
    category: 'Identity',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: config.name,
      displayName: config.displayName,
      description: config.description,
      type: 'service',
      helm: config.helm,
      overlaySecret: config.overlaySecret,
      deployments: config.deployments,
      waitForReady: config.waitForReady,
      cleanup: config.cleanup,
      manifests: config.manifests,
      rawValues: config.rawValues,
    },
    tags: ['identity', 'sso', 'auth'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ── Remote config loading ───────────────────────────────────────────────────────

const REMOTE_MANIFEST_URL =
  typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_PROVIDER_MANIFEST_URL
    || 'https://raw.githubusercontent.com/richard-callis/orion-nub/refs/heads/main/manifest.json'

let _remoteNovae: Map<string, Nova> = new Map()

export async function loadRemoteNovae(): Promise<Map<string, Nova>> {
  if (_remoteNovae.size > 0) return _remoteNovae
  try {
    const manifestRes = await fetch(REMOTE_MANIFEST_URL)
    if (!manifestRes.ok) return _remoteNovae
    const manifest = await manifestRes.json()
    for (const provider of manifest.providers) {
      try {
        const configRes = await fetch(
          `https://raw.githubusercontent.com/richard-callis/orion-nub/refs/heads/main/providers/${provider.name}.json`
        )
        if (!configRes.ok) continue
        const config = await configRes.json()
        _remoteNovae.set(provider.name, {
          id: `remote_${provider.name}`,
          name: provider.name,
          displayName: provider.displayName,
          description: provider.description,
          category: 'Identity',
          version: manifest.version || '1.0.0',
          source: 'remote',
          config: {
            name: provider.name,
            displayName: provider.displayName,
            description: provider.description,
            type: 'service',
            ...config,
          },
          tags: [provider.name, 'identity'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      } catch {
        // Skip individual provider loads that fail
      }
    }
  } catch {
    // Remote unavailable — fall back to bundled
  }
  return _remoteNovae
}

/** Reload all remote Nova definitions from the manifest (e.g. after cache invalidation). */
export async function reloadRemoteNovae(): Promise<string[]> {
  _remoteNovae.clear()
  return (await loadRemoteNovae()).keys()
}

// ── Nova registry (merged from all sources) ─────────────────────────────────────

export async function getAllNovae(): Promise<Nova[]> {
  const remoteNovae = await loadRemoteNovae()
  const merged: Nova[] = [...Object.values(BUNDLED_NOVAE)]

  // Add remote Novae (skip if already in bundled)
  for (const nova of remoteNovae.values()) {
    if (!merged.find(n => n.name === nova.name)) {
      merged.push(nova)
    }
  }

  return merged
}

export async function getNova(name: string): Promise<Nova | undefined> {
  // Check bundled first
  const bundled = BUNDLED_NOVAE[name]
  if (bundled) return bundled

  // Check remote
  const remoteNovae = await loadRemoteNovae()
  const remote = remoteNovae.get(name)
  if (remote) return remote

  return undefined
}

/**
 * Get a Nova provider config by name (legacy compatibility).
 * Returns the underlying ProviderConfig if available.
 */
export async function getNovaProviderConfig(name: string): Promise<ProviderConfig | undefined> {
  // Check bundled first (fast path)
  const bundled = getProviderSync(name)
  if (bundled) return bundled

  // Try remote
  const remote = await getProvider(name)
  if (remote) return remote

  return undefined
}
