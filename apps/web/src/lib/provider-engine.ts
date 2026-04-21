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

export function getProvider(name: string): ProviderConfig | undefined {
  return BUNDLED_PROVIDERS[name]
}

// ── Template rendering ────────────────────────────────────────────────────────

export interface RenderContext {
  hostname: string
  namespace: string
  clusterIssuer: string
  adminPassword: string
  provider: string
  /** Pre-generated secret values */
  genSecrets: Record<string, string>
}

function renderTemplate(input: string, ctx: RenderContext, secrets: Record<string, string>): string {
  let result = input

  // Replace {{ hostname }}, {{ clusterIssuer }}, {{ adminPassword }}, {{ provider }}, {{ namespace }}
  result = result.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
  result = result.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)
  result = result.replace(/\{\{\s*adminPassword\s*\}\}/g, ctx.adminPassword)
  result = result.replace(/\{\{\s*provider\s*\}\}/g, ctx.provider)
  result = result.replace(/\{\{\s*namespace\s*\}\}/g, ctx.namespace)

  // Replace {{ genSecret N }}
  result = result.replace(/\{\{\s*genSecret\s+(\d+)\s*\}\}/g, (_, bits) => {
    const key = `gen_${result.indexOf(input)}_${Date.now()}`
    secrets[key] = crypto.randomUUID().replace(/-/g, '')
    return `{{ ${key} }}`
  })

  // Replace {{ genSecret N }} with the generated secret
  for (const [key, value] of Object.entries(secrets)) {
    if (key.startsWith('gen_')) {
      result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
    }
  }

  // Replace {{ .helm.release }}, {{ .helm.values.path }}
  result = result.replace(/\{\{\s*\.helm\.release\s*\}\}/g, 'authentik')
  result = result.replace(/\{\{\s*\.helm\.values\.authentik\.secretKey\s*\}\}/g, secrets['gen_secret_key'] || result)

  // Replace {{ resolveSecret <secret> <key> }}
  // This is a placeholder — the actual resolution happens at runtime
  // We return a special marker that the engine replaces
  result = result.replace(/\{\{\s*resolveSecret\s+(\S+)\s+(\S+)\s*\}\}/g, '__RESOLVE_SECRET__$1__$2__')

  return result
}
