/**
 * Dynamic provider deployment engine.
 *
 * Loads provider configs from JSON files and executes deployments
 * without hardcoded per-provider logic.
 *
 * Config location: deploy/providers/<provider>.json (mounted as static asset)
 * Fallback: bundled configs embedded in this module.
 */

export interface ProviderConfig {
  name: string
  displayName: string
  description: string
  helm?: HelmConfig
  overlaySecret?: OverlaySecretConfig
  deployments: DeploymentTarget[]
  waitForReady?: WaitForReadyConfig
  cleanup?: CleanupConfig
  /** Custom manifests to apply */
  manifests?: string[]
  /** Custom helm values as inline string */
  rawValues?: string
}

export interface HelmConfig {
  release: string
  chart: string
  repo: string
  values: Record<string, unknown>
  wait?: boolean
  timeout?: string
}

export interface OverlaySecretConfig {
  name: string
  /** Template entries: value or source references */
  entries: TemplateEntry[]
}

export interface TemplateEntry {
  key: string
  value: string
}

export interface DeploymentTarget {
  name: string
  containerName: string
}

export interface WaitForReadyConfig {
  statefulset?: { name: string; timeout: number }
  deployment?: { name: string; timeout: number }
}

export interface CleanupConfig {
  helmRelease?: string
  helmReleaseTimeout?: string
  statefulsets?: string[]
  deployments?: string[]
  secrets?: string[]
  services?: string[]
  ingresses?: string[]
  certificates?: string[]
  challenges?: string[]
  orders?: string[]
  pvcPrefixes?: string[]
}

// ── Bundled configs (embedded at build time) ──────────────────────────────────

export const BUNDLED_PROVIDERS: Record<string, ProviderConfig> = {
  authentik: {
    name: 'authentik',
    displayName: 'Authentik',
    description: 'Open-source identity provider with SSO, MFA, and passwordless auth',
    helm: {
      release: 'authentik',
      chart: 'goauthentik/authentik',
      repo: 'https://charts.goauthentik.io',
      values: {
        authentik: { secretKey: '{{ genSecret 64 }}' },
        server: {
          replicaCount: 1,
          ingress: {
            enabled: true,
            ingressClassName: 'traefik',
            hosts: ['{{ hostname }}'],
            annotations: { 'cert-manager.io/cluster-issuer': '{{ clusterIssuer }}' },
            tls: [{ secretName: 'authentik-tls', hosts: ['{{ hostname }}'] }],
          },
        },
        postgresql: { enabled: true },
      },
      wait: false,
      timeout: '300s',
    },
    overlaySecret: {
      name: 'authentik-secret-fix',
      entries: [
        { key: 'AUTHENTIK_SECRET_KEY', value: '{{ .helm.values.authentik.secretKey }}' },
        { key: 'AUTHENTIK_ROOT_PASSWORD', value: '{{ adminPassword }}' },
        { key: 'AUTHENTIK_POSTGRESQL__HOST', value: '{{ .helm.release }}-postgresql' },
        { key: 'AUTHENTIK_POSTGRESQL__NAME', value: 'authentik' },
        { key: 'AUTHENTIK_POSTGRESQL__USER', value: 'authentik' },
        { key: 'AUTHENTIK_POSTGRESQL__PORT', value: '5432' },
        { key: 'AUTHENTIK_POSTGRESQL__PASSWORD', value: '{{ resolveSecret authentik-postgresql password }}' },
      ],
    },
    deployments: [
      { name: 'authentik-server', containerName: 'server' },
      { name: 'authentik-worker', containerName: 'worker' },
    ],
    waitForReady: {
      statefulset: { name: '{{ .helm.release }}-postgresql', timeout: 60 },
      deployment: { name: '{{ .helm.release }}-server', timeout: 600 },
    },
    cleanup: {
      helmRelease: 'authentik',
      helmReleaseTimeout: '120s',
      statefulsets: ['authentik-postgresql', 'authentik-redis'],
      deployments: ['authentik-redis'],
      secrets: ['authentik', 'authentik-secrets', 'authentik-secret-key', 'authentik-root-password', 'authentik-postgresql'],
      services: ['authentik-server', 'authentik-postgresql', 'authentik-redis', 'authentik-worker', 'authentik-goauthentikio'],
      ingresses: ['authentik'],
      certificates: ['authentik-tls'],
      challenges: ['authentik-tls'],
      orders: ['authentik-tls'],
      pvcPrefixes: ['data-authentik-postgresql-', 'redis-data-authentik-redis-'],
    },
  },
  authelia: {
    name: 'authelia',
    displayName: 'Authelia',
    description: 'Open-source authentication and authorization web application',
    helm: {
      release: 'authelia',
      chart: 'bitnami/authelia',
      repo: 'https://charts.bitnami.com/bitnami',
      values: {
        ingress: {
          enabled: true,
          className: 'traefik',
          hosts: ['{{ hostname }}'],
          annotations: { 'cert-manager.io/cluster-issuer': '{{ clusterIssuer }}' },
          tls: [{ secretName: 'authelia-tls', hosts: ['{{ hostname }}'] }],
        },
      },
      wait: false,
      timeout: '300s',
    },
    deployments: [{ name: 'authelia', containerName: 'authelia' }],
    waitForReady: {
      deployment: { name: 'authelia', timeout: 300 },
    },
    cleanup: {
      helmRelease: 'authelia',
      deployments: ['authelia'],
      secrets: ['authelia'],
      services: ['authelia'],
      ingresses: ['authelia'],
    },
  },
}

// ── Remote config loading ─────────────────────────────────────────────────────

export interface RemoteManifest {
  version: string
  providers: Array<{
    name: string
    displayName: string
    description: string
    url: string
  }>
}

declare const process: { env: Record<string, string | undefined> }

const REMOTE_MANIFEST_URL =
  typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_PROVIDER_MANIFEST_URL
    || 'https://raw.githubusercontent.com/richard-callis/orion-flux/refs/heads/main/manifest.json'

let _remoteManifest: RemoteManifest | null = null
let _remoteConfigs: Map<string, ProviderConfig> = new Map()

async function loadRemoteManifest(): Promise<RemoteManifest | null> {
  if (_remoteManifest) return _remoteManifest
  try {
    const res = await fetch(REMOTE_MANIFEST_URL)
    if (!res.ok) return null
    _remoteManifest = await res.json()
    return _remoteManifest
  } catch {
    return null
  }
}

async function loadRemoteConfig(name: string): Promise<ProviderConfig | null> {
  if (_remoteConfigs.has(name)) return _remoteConfigs.get(name)!
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/richard-callis/orion-flux/refs/heads/main/providers/${name}.json`
    )
    if (!res.ok) return null
    const config = await res.json()
    _remoteConfigs.set(name, config)
    return config
  } catch {
    return null
  }
}

/**
 * Get a provider config, checking remote first then bundled fallback.
 * Remote load is lazy — first call fetches from GitHub, subsequent calls use cache.
 */
export async function getProvider(
  name: string
): Promise<ProviderConfig | undefined> {
  // Check bundled first (fast path, always available)
  const bundled = BUNDLED_PROVIDERS[name]
  if (bundled) return bundled

  // Try remote
  const remote = await loadRemoteConfig(name)
  if (remote) return remote

  return undefined
}

/**
 * Synchronous version — only returns bundled configs.
 * Use getProvider() for async with remote support.
 */
export function getProviderSync(name: string): ProviderConfig | undefined {
  return BUNDLED_PROVIDERS[name]
}

/** Reload all remote configs from the manifest (e.g. after cache invalidation). */
export async function reloadRemoteConfigs(): Promise<string[]> {
  _remoteManifest = null
  _remoteConfigs.clear()
  const manifest = await loadRemoteManifest()
  if (!manifest) return []
  const loaded: string[] = []
  for (const p of manifest.providers) {
    const config = await loadRemoteConfig(p.name)
    if (config) loaded.push(p.name)
  }
  return loaded
}

// ── Template rendering ────────────────────────────────────────────────────────

export interface RenderContext {
  hostname: string
  namespace: string
  clusterIssuer: string
  adminPassword: string
  provider: string
  /** Helm release name (for .helm.release templates) */
  helmRelease?: string
  /** Pre-generated secret values */
  genSecrets: Record<string, string>
}

/**
 * Render template placeholders in a ProviderConfig and return a new rendered copy.
 * Handles:
 *   - {{ hostname }}, {{ clusterIssuer }}, {{ adminPassword }}, {{ provider }}, {{ namespace }}
 *   - {{ genSecret N }} → random string, stored in context.genSecrets
 *   - {{ .helm.release }} → resolved from context.helmRelease or config name
 *   - {{ .helm.values.<path> }} → resolved from rendered helm values
 *   - {{ resolveSecret <name> <key> }} → returns a __RS_<name>_<key>__ placeholder
 *     (actual resolution happens at runtime in syncOverlaySecret)
 */
export function renderProviderConfig(
  config: ProviderConfig,
  ctx: RenderContext,
): ProviderConfig {
  const secrets = ctx.genSecrets
  const helmRelease = ctx.helmRelease ?? config.name

  // First pass: generate secrets and collect .helm.values paths
  // We render values recursively, tracking which paths we hit for .helm.values.* resolution
  const valuesMap = new Map<string, unknown>()
  renderValues(config.helm?.values, secrets, ctx, valuesMap)

  function resolveTemplate(input: string): string {
    let result = input

    // Replace {{ genSecret N }}
    result = result.replace(/\{\{\s*genSecret\s+(\d+)\s*\}\}/g, () => {
      const key = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      secrets[key] = crypto.randomUUID().replace(/-/g, '')
      return `{{ ${key} }}`
    })

    // Resolve genSecret values
    for (const [key, value] of Object.entries(secrets)) {
      if (key.startsWith('gen_')) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
      }
    }

    // Replace {{ .helm.release }}
    result = result.replace(/\{\{\s*\.helm\.release\s*\}\}/g, helmRelease)

    // Replace {{ .helm.values.<path> }} — e.g. authentik.secretKey
    result = result.replace(/\{\{\s*\.helm\.values\.(.+)\s*\}\}/g, (_: string, path: string) => {
      // path like "authentik.secretKey"
      const parts = path.split('.')
      // Look up in the rendered values map
      const rendered = valuesMap.get(parts.join('.'))
      if (typeof rendered === 'string') return rendered
      return `{{ .helm.values.${path} }}` // leave unresolved
    })

    // Replace simple context vars
    result = result.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
    result = result.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)
    result = result.replace(/\{\{\s*adminPassword\s*\}\}/g, ctx.adminPassword)
    result = result.replace(/\{\{\s*provider\s*\}\}/g, ctx.provider)
    result = result.replace(/\{\{\s*namespace\s*\}\}/g, ctx.namespace)

    // Replace {{ resolveSecret <name> <key> }} with placeholder
    result = result.replace(
      /\{\{\s*resolveSecret\s+(\S+)\s+(\S+)\s*\}\}/g,
      (_: string, secretName: string, secretKey: string) => `__RS_${secretName}_${secretKey}__`
    )

    return result
  }

  function deepReplace<T>(obj: T): T {
    if (typeof obj === 'string') {
      return resolveTemplate(obj) as T
    }
    if (Array.isArray(obj)) {
      return obj.map(deepReplace) as unknown as T
    }
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        result[k] = deepReplace(v)
      }
      return result as T
    }
    return obj
  }

  return {
    ...config,
    helm: config.helm ? {
      ...config.helm,
      values: valuesMap as unknown as Record<string, unknown>,
    } : undefined,
    overlaySecret: config.overlaySecret ? {
      ...config.overlaySecret,
      entries: config.overlaySecret.entries.map(e => ({
        ...e,
        value: deepReplace(e.value),
      })),
    } : undefined,
    deployments: config.deployments.map(d => ({ ...d })),
    waitForReady: config.waitForReady ? {
      ...config.waitForReady,
      statefulset: config.waitForReady.statefulset ? {
        ...config.waitForReady.statefulset,
        name: deepReplace(config.waitForReady.statefulset.name) as string,
      } : undefined,
      deployment: config.waitForReady.deployment ? {
        ...config.waitForReady.deployment,
        name: deepReplace(config.waitForReady.deployment.name) as string,
      } : undefined,
    } : undefined,
  }
}

/**
 * Render Helm values — resolve {{ genSecret }} and track paths for .helm.values.* resolution.
 * Returns the rendered map (JSON path → final value).
 */
function renderValues(
  input: unknown,
  secrets: Record<string, string>,
  ctx: RenderContext,
  pathMap: Map<string, unknown>,
  currentPath = '',
): Map<string, unknown> {
  if (typeof input === 'string') {
    let result = input

    // genSecret
    result = result.replace(/\{\{\s*genSecret\s+(\d+)\s*\}\}/g, () => {
      const key = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      secrets[key] = crypto.randomUUID().replace(/-/g, '')
      // Self-reference: resolve immediately
      secrets[key] = crypto.randomUUID().replace(/-/g, '')
      return secrets[key]
    })

    // Simple context vars in values
    result = result.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
    result = result.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)

    if (currentPath) pathMap.set(currentPath, result)
    return pathMap
  }

  if (Array.isArray(input)) {
    const arr: unknown[] = []
    for (let i = 0; i < input.length; i++) {
      arr.push(renderValues(input[i], secrets, ctx, pathMap, `${currentPath}[${i}]`))
    }
    if (currentPath) pathMap.set(currentPath, arr)
    return pathMap
  }

  if (input && typeof input === 'object') {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const path = currentPath ? `${currentPath}.${k}` : k
      obj[k] = renderValues(v, secrets, ctx, pathMap, path)
    }
    if (currentPath) pathMap.set(currentPath, obj)
    return pathMap
  }

  if (currentPath) pathMap.set(currentPath, input)
  return pathMap
}
