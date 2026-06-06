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
  /** Namespace labels to apply before installing (map of namespace → labels) */
  namespaceLabels?: Record<string, Record<string, string>>
  /** UI icon name (maps to lucide-react icon) */
  icon?: string
  /** Post-install instructions shown to the operator */
  setupNote?: string
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
  source: 'bundled' | 'remote' | 'user-created' | 'nebula'
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

// Bundled middleware Novas — always available without Nebula/git setup.
// The deploy logic for these lives in apps/web/src/app/api/ingress/points/[id]/bootstrap-middleware/route.ts.
const BUNDLED_MIDDLEWARE: Nova[] = [
  {
    id: 'bundled_crowdsec',
    name: 'crowdsec',
    displayName: 'CrowdSec',
    description: 'Behavioral IPS with Traefik bouncer for automated IP banning',
    category: 'Other',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: 'crowdsec',
      displayName: 'CrowdSec',
      description: 'Behavioral IPS with Traefik bouncer for automated IP banning',
      type: 'service',
      icon: 'Shield',
      setupNote: 'After install, generate the bouncer API key:\n  kubectl exec -n crowdsec deploy/crowdsec-lapi -- cscli bouncers add traefik-bouncer -o raw\nThen patch the secret:\n  kubectl create secret generic crowdsec-traefik-bouncer -n crowdsec --from-literal=api_key=<KEY> --dry-run=client -o yaml | kubectl apply -f -',
    },
    tags: ['middleware', 'security'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bundled_rate-limit',
    name: 'rate-limit',
    displayName: 'Rate Limiting',
    description: 'Per-IP request rate limiting via Traefik — protects against brute force and scrapers',
    category: 'Other',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: 'rate-limit',
      displayName: 'Rate Limiting',
      description: 'Per-IP request rate limiting via Traefik',
      type: 'service',
      icon: 'Gauge',
      namespaceLabels: { security: {} },
      manifests: [
        'apiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: rate-limit\n  namespace: security\nspec:\n  rateLimit:\n    average: 100\n    burst: 50\n    period: 1m\n    sourceCriterion:\n      ipStrategy:\n        depth: 1',
      ],
    },
    tags: ['middleware', 'security'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bundled_secure-headers',
    name: 'secure-headers',
    displayName: 'Secure Headers',
    description: 'HSTS, X-Frame-Options, CSP, and other security headers applied via Traefik',
    category: 'Other',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: 'secure-headers',
      displayName: 'Secure Headers',
      description: 'HSTS, X-Frame-Options, CSP, and other security headers applied via Traefik',
      type: 'service',
      icon: 'ShieldCheck',
      namespaceLabels: { security: {} },
      manifests: [
        'apiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: secure-headers\n  namespace: security\nspec:\n  headers:\n    stsSeconds: 31536000\n    stsIncludeSubdomains: true\n    stsPreload: true\n    forceSTSHeader: true\n    frameDeny: true\n    contentTypeNosniff: true\n    browserXssFilter: true\n    referrerPolicy: strict-origin-when-cross-origin\n    customResponseHeaders:\n      X-Robots-Tag: "noindex,nofollow,nosnippet,noarchive"\n      Server: ""',
      ],
    },
    tags: ['middleware', 'security'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bundled_ip-allowlist',
    name: 'ip-allowlist',
    displayName: 'IP Allowlist',
    description: 'Restrict access to specific IP ranges — useful for locking down admin services',
    category: 'Other',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: 'ip-allowlist',
      displayName: 'IP Allowlist',
      description: 'Restrict access to specific IP ranges',
      type: 'service',
      icon: 'Lock',
      setupNote: 'Edit the sourceRange list after install to add your allowed CIDRs:\n  kubectl edit middleware ip-allowlist -n security',
      namespaceLabels: { security: {} },
      manifests: [
        'apiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: ip-allowlist\n  namespace: security\nspec:\n  ipAllowList:\n    sourceRange:\n      - 127.0.0.1/32\n      - 10.0.0.0/8\n      - 192.168.0.0/16',
      ],
    },
    tags: ['middleware', 'security', 'access-control'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bundled_basic-auth',
    name: 'basic-auth',
    displayName: 'Basic Auth',
    description: 'Simple username/password protection for services not covered by SSO',
    category: 'Other',
    version: '1.0.0',
    source: 'bundled',
    config: {
      name: 'basic-auth',
      displayName: 'Basic Auth',
      description: 'Simple username/password protection',
      type: 'service',
      icon: 'KeyRound',
      setupNote: 'Create the auth secret before using:\n  kubectl create secret generic basic-auth -n security \\\n    --from-literal=users=$(htpasswd -nb admin yourpassword)',
      namespaceLabels: { security: {} },
      manifests: [
        'apiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: basic-auth\n  namespace: security\nspec:\n  basicAuth:\n    secret: basic-auth\n    removeHeader: true',
      ],
    },
    tags: ['middleware', 'auth'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

for (const nova of BUNDLED_MIDDLEWARE) {
  BUNDLED_NOVAE[nova.name] = nova
}

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
  const m = await loadRemoteNovae()
  return Array.from(m.keys())
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
