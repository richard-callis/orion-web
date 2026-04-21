/**
 * POST /api/ingress/points/:id/bootstrap-sso
 *
 * Bootstraps an identity provider (Authentik, Authelia, OAuth2 Proxy, Keycloak, or Custom OIDC)
 * into the associated environment.
 *
 * Falls back to local kubectl execution (via stored kubeconfig) if the gateway is unreachable.
 *
 * Returns { jobId } immediately — progress tracked via /api/jobs/[id].
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startJob, type JobLogger } from '@/lib/job-runner'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'
import { requireAdmin } from '@/lib/auth'
import { makeLocalGx } from '@/lib/local-exec'

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const point = await prisma.ingressPoint.findUnique({
    where: { id: params.id },
    include: { environment: true },
  })
  if (!point) {
    return NextResponse.json({ error: 'IngressPoint not found' }, { status: 404 })
  }
  if (!point.environment) {
    return NextResponse.json({ error: 'IngressPoint has no associated environment' }, { status: 422 })
  }

  const env = point.environment
  const body = await _req.json().catch(() => ({}))
  const provider = String(body.provider ?? 'authentik')
  const hostname = String(body.hostname ?? '')
  const namespace = String(body.namespace ?? 'security')
  const clusterIssuer = String(body.clusterIssuer ?? 'letsencrypt-prod')
  const adminPassword = String(body.adminPassword ?? '')
  const oidcIssuerUrl = String(body.oidcIssuerUrl ?? '')
  const clientId = String(body.clientId ?? '')
  const clientSecret = String(body.clientSecret ?? '')
  const customIssuerCaSecret = String(body.customIssuerCaSecret ?? '')
  const databaseType = String(body.databaseType ?? 'sqlite')
  const redisHost = String(body.redisHost ?? '')

  if (!hostname) {
    return NextResponse.json({ error: 'Hostname is required' }, { status: 422 })
  }

  // Determine execution mode: gateway first, fallback to local kubeconfig
  const gwUrl = env.gatewayUrl
  const gwToken = env.gatewayToken
  const hasKubeconfig = Boolean(env.kubeconfig)

  let useGateway = false
  let useLocal = false

  if (gwUrl && gwToken) {
    // Try the gateway
    try {
      const res = await fetch(`${gwUrl}/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
        body: JSON.stringify({ name: 'kubectl_get_nodes', arguments: { wide: false } }),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        useGateway = true
      }
    } catch {
      // Gateway unreachable
    }
  }

  if (!useGateway && hasKubeconfig) {
    useLocal = true
  }

  if (!useGateway && !useLocal) {
    if (gwUrl && !gwToken) {
      return NextResponse.json({ error: 'Gateway URL set but no gateway token' }, { status: 422 })
    }
    if (gwToken && !gwUrl) {
      return NextResponse.json({ error: 'Gateway token set but no gateway URL' }, { status: 422 })
    }
    if (gwUrl && gwToken) {
      return NextResponse.json({ error: `Gateway at ${gwUrl} is not reachable and no kubeconfig is stored. Deploy the gateway via the Environment settings page.` }, { status: 422 })
    }
    return NextResponse.json({ error: 'No gateway available and no kubeconfig stored. Deploy the gateway or upload a kubeconfig for this environment.' }, { status: 422 })
  }

  const jobId = await startJob(
    'bootstrap-sso',
    `Bootstrap SSO (${provider}) — ${hostname}`,
    { environmentId: env.id, metadata: { provider, hostname, namespace, useGateway, useLocal } },
    async log => {
      if (useGateway) {
        await log(`Using gateway at ${gwUrl} for cluster operations`)
        const gc = new GatewayClient(gwUrl!, gwToken!)
        await bootstrapProvider(gwExecFn(gc), log, { provider, hostname, namespace, clusterIssuer, adminPassword, oidcIssuerUrl, clientId, clientSecret, customIssuerCaSecret, databaseType, redisHost, isDocker: false })
      } else if (useLocal) {
        await log(`Using local kubectl (stored kubeconfig) for cluster operations`)
        await bootstrapProvider(makeLocalGx(env.kubeconfig!), log, { provider, hostname, namespace, clusterIssuer, adminPassword, oidcIssuerUrl, clientId, clientSecret, customIssuerCaSecret, databaseType, redisHost, isDocker: false })
      }
    },
  )

  return NextResponse.json({ jobId })
}

function gwExecFn(gc: GatewayClient) {
  return (tool: string, args: Record<string, unknown>) => gc.executeTool(tool, args)
}

// Check for and remove stale Helm releases from previous failed deployments
async function cleanupStaleHelmRelease(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { provider: string; hostname: string; namespace: string },
): Promise<void> {
  const releaseNames: Record<string, string> = {
    authentik: 'authentik',
    authelia: 'authelia',
    oauth2_proxy: 'oauth2-proxy',
    keycloak: 'keycloak',
    custom_oidc: 'oauth2-proxy',
  }
  const releaseName = releaseNames[cfg.provider]
  if (!releaseName) return

  // Check if the release exists
  try {
    const result = await gx('helm_list', { namespace: cfg.namespace, filter: releaseName })
    if (result.includes(releaseName)) {
      await log(`  Found stale release '${releaseName}', cleaning up...`)
      await gx('helm_uninstall', { release: releaseName, namespace: cfg.namespace })
      await log('  Stale release removed ✓')
    }
  } catch {
    // No existing release — nothing to clean up
  }
}

async function bootstrapProvider(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: {
    provider: string; hostname: string; namespace: string; clusterIssuer: string
    adminPassword: string; oidcIssuerUrl: string; clientId: string; clientSecret: string
    customIssuerCaSecret: string; databaseType: string; redisHost: string; isDocker: boolean
  },
): Promise<void> {
  // Clean up stale Helm release, deployments, and pods from previous failed attempts
  await cleanupStaleHelmRelease(gx, log, cfg)

  // Delete stale deployments and pods that persist after Helm uninstall
  // Delete Helm-managed workloads
  await gx('kubectl_delete', { resource: 'deployment', name: 'authentik-server', namespace: cfg.namespace }).catch(() => {})
  await gx('kubectl_delete', { resource: 'deployment', name: 'authentik-worker', namespace: cfg.namespace }).catch(() => {})
  await gx('kubectl_delete', { resource: 'statefulset', name: 'authentik-postgresql', namespace: cfg.namespace }).catch(() => {})
  // Delete bootstrap-created workloads (separate from Helm release)
  await gx('kubectl_delete', { resource: 'statefulset', name: 'authentik-postgres', namespace: cfg.namespace }).catch(() => {})
  await gx('kubectl_delete', { resource: 'deployment', name: 'authentik-redis', namespace: cfg.namespace }).catch(() => {})
  // Delete any remaining pods with authentik labels
  await gx('kubectl_delete', { resource: 'pods', namespace: cfg.namespace, selector: 'app.kubernetes.io/instance=authentik' }).catch(() => {})

  await log(`Deploying ${cfg.provider} identity provider to namespace "${cfg.namespace}"`)

  // Ensure namespace exists with PodSecurity bypass (Talos defaults to restricted policy)
  // Always apply — namespace manifests with annotations can be reapplied to add/update annotations
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Namespace
metadata:
  name: ${cfg.namespace}
  annotations:
    pod-security.kubernetes.io/enforce: "privileged"
    pod-security.kubernetes.io/audit: "privileged"
    pod-security.kubernetes.io/warn: "privileged"`,
  })

  switch (cfg.provider) {
    case 'authentik':     await deployAuthentik(gx, log, cfg); break
    case 'authelia':      await deployAuthelia(gx, log, cfg); break
    case 'oauth2_proxy':  await deployOAuth2Proxy(gx, log, cfg); break
    case 'keycloak':      await deployKeycloak(gx, log, cfg); break
    case 'custom_oidc':   await deployCustomOIDC(gx, log, cfg); break
    default:
      throw new Error(`Unknown SSO provider: ${cfg.provider}`)
  }
}

// ── Authentik ────────────────────────────────────────────────────────────────

async function deployAuthentik(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { hostname: string; namespace: string; adminPassword: string; clusterIssuer: string; isDocker: boolean },
): Promise<void> {
  // Generate a cryptographically suitable secret key for Authentik
  const secretKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 20)}${Math.random().toString(36).slice(2, 16)}`
  const postgresPassword = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 16)}`

  // Create the overlay secret that provides the correct env var names
  // Helm chart generates AUTHENTIK_SECRETKEY (no underscore) but Authentik expects AUTHENTIK_SECRET_KEY
  await log('Step 1/3: Creating overlay secret...')
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Secret
metadata:
  name: authentik-secret-fix
  namespace: ${cfg.namespace}
type: Opaque
stringData:
  AUTHENTIK_SECRET_KEY: "${secretKey}"
  AUTHENTIK_ROOT_PASSWORD: "${cfg.adminPassword}"`,
  })
  await log('  Overlay secret created ✓')

  // Install Authentik via Helm (manages PostgreSQL subchart with our password)
  await log('Step 2/3: Installing Authentik via Helm...')
  await gx('helm_upgrade_install', {
    release: 'authentik', chart: 'authentik', repo: 'https://charts.goauthentik.io',
    namespace: cfg.namespace, createNamespace: false, valuesFile: `authentik:
  secretKey: "${secretKey}"
  rootPassword: "${cfg.adminPassword}"
server:
  replicaCount: 1
  ingress:
    enabled: true
    ingressClassName: traefik
    hosts:
      - ${cfg.hostname}
    annotations:
      cert-manager.io/cluster-issuer: ${cfg.clusterIssuer}
      traefik.ingress.kubernetes.io/router.entrypoints: "websecure"
      traefik.ingress.kubernetes.io/router.tls: "true"
    tls:
      - secretName: authentik-tls
        hosts:
          - ${cfg.hostname}
postgresql:
  auth:
    password: "${postgresPassword}"
`, wait: false, timeout: '300s',
  })
  await log('  Authentik installed ✓')
  await log('  Authentik installed ✓')

  // Step 3: Patch the secret key env var name
  // Helm chart converts authentik.secretKey → AUTHENTIK_SECRETKEY (no underscore)
  // but Authentik expects AUTHENTIK_SECRET_KEY (with underscore). Patch deployments
  // to include the overlay secret in envFrom so the correct key name wins.
  await log('Step 3/3: Patching secret key env var name...')
  await gx('kubectl_patch', {
    resource: 'deployment', name: 'authentik-server', namespace: cfg.namespace,
    patchType: 'strategic',
    patch: JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'server',
              envFrom: [
                { secretRef: { name: 'authentik' } },
                { secretRef: { name: 'authentik-secrets' } },
                { secretRef: { name: 'authentik-secret-fix' } },
              ],
            }],
          },
        },
      },
    }),
  })
  await gx('kubectl_patch', {
    resource: 'deployment', name: 'authentik-worker', namespace: cfg.namespace,
    patchType: 'strategic',
    patch: JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'worker',
              envFrom: [
                { secretRef: { name: 'authentik' } },
                { secretRef: { name: 'authentik-secrets' } },
                { secretRef: { name: 'authentik-secret-fix' } },
              ],
            }],
          },
        },
      },
    }),
  })
  await log('  Secret key patched ✓')
}

// ── Authelia ─────────────────────────────────────────────────────────────────

async function deployAuthelia(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { hostname: string; namespace: string; isDocker: boolean },
): Promise<void> {
  await log('Deploying Authelia manifests...')

  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: authelia
  namespace: ${cfg.namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: authelia
  template:
    metadata:
      labels:
        app: authelia
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      automountServiceAccountToken: false
      containers:
        - name: authelia
          image: authelia/authelia:latest
          ports:
            - containerPort: 9091
              name: http
          volumeMounts:
            - mountPath: /config
              name: config
      volumes:
        - emptyDir: {}
          name: config
---
apiVersion: v1
kind: Service
metadata:
  name: authelia
  namespace: ${cfg.namespace}
spec:
  selector:
    app: authelia
  ports:
    - name: http
      port: 9091
      targetPort: 9091
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: authelia
  namespace: ${cfg.namespace}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: "websecure"
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  rules:
    - host: ${cfg.hostname}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: authelia
                port:
                  number: 9091
  tls:
    - hosts:
        - ${cfg.hostname}
      secretName: authelia-tls`,
  })
  await log('  Authelia deployed ✓')
}

// ── OAuth2 Proxy ─────────────────────────────────────────────────────────────

async function deployOAuth2Proxy(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { hostname: string; namespace: string; oidcIssuerUrl: string; clientId: string; clientSecret: string; isDocker: boolean },
): Promise<void> {
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oauth2-proxy
  template:
    metadata:
      labels:
        app: oauth2-proxy
    spec:
      automountServiceAccountToken: false
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:latest
          args:
            - '--provider=oidc'
            - '--provider-discovery-url=$(OIDC_ISSUER_URL)'
            - '--client-id=$(CLIENT_ID)'
            - '--client-secret=$(CLIENT_SECRET)'
            - '--redirect-url=https://$(HOSTNAME)/oauth2/callback'
            - '--email-domain=*'
          env:
            - name: OIDC_ISSUER_URL
              value: "${cfg.oidcIssuerUrl}"
            - name: CLIENT_ID
              value: "${cfg.clientId}"
            - name: CLIENT_SECRET
              value: "${cfg.clientSecret}"
            - name: HOSTNAME
              value: "${cfg.hostname}"
          ports:
            - containerPort: 4180
              name: http
---
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
spec:
  selector:
    app: oauth2-proxy
  ports:
    - name: http
      port: 4180
      targetPort: 4180
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: "websecure"
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  rules:
    - host: ${cfg.hostname}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: oauth2-proxy
                port:
                  number: 4180
  tls:
    - hosts:
        - ${cfg.hostname}
      secretName: oauth2-proxy-tls`,
  })
  await log('  OAuth2 Proxy deployed ✓')
}

// ── Keycloak ─────────────────────────────────────────────────────────────────

async function deployKeycloak(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { hostname: string; namespace: string; adminPassword: string; isDocker: boolean },
): Promise<void> {
  const valuesFile = `auth:
  adminUser: admin
  adminPassword: ${cfg.adminPassword}
hostname:
  hostname: ${cfg.hostname}
  tls:
    autoGenerated: true
  ingress:
    enabled: true
    ingressClassName: traefik
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
replicaCount: 1
`

  await log('Installing Keycloak via Helm...')
  await gx('helm_upgrade_install', {
    release: 'keycloak', chart: 'keycloak', repo: 'https://charts.bitnami.com/bitnami',
    namespace: cfg.namespace, createNamespace: false, valuesFile, wait: false, timeout: '300s',
  })
  await log('  Keycloak installed ✓')
}

// ── Custom OIDC ──────────────────────────────────────────────────────────────

async function deployCustomOIDC(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { hostname: string; namespace: string; oidcIssuerUrl: string; clientId: string; clientSecret: string; isDocker: boolean },
): Promise<void> {
  await log('Deploying OAuth2 Proxy as the transport for custom OIDC provider')

  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oauth2-proxy
  template:
    metadata:
      labels:
        app: oauth2-proxy
    spec:
      automountServiceAccountToken: false
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:latest
          args:
            - '--provider=oidc'
            - '--provider-discovery-url=$(OIDC_ISSUER_URL)'
            - '--client-id=$(CLIENT_ID)'
            - '--client-secret=$(CLIENT_SECRET)'
            - '--redirect-url=https://$(HOSTNAME)/oauth2/callback'
            - '--email-domain=*'
          env:
            - name: OIDC_ISSUER_URL
              value: "${cfg.oidcIssuerUrl}"
            - name: CLIENT_ID
              value: "${cfg.clientId}"
            - name: CLIENT_SECRET
              value: "${cfg.clientSecret}"
            - name: HOSTNAME
              value: "${cfg.hostname}"
          ports:
            - containerPort: 4180
              name: http
---
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
spec:
  selector:
    app: oauth2-proxy
  ports:
    - name: http
      port: 4180
      targetPort: 4180
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oauth2-proxy
  namespace: ${cfg.namespace}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: "websecure"
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  rules:
    - host: ${cfg.hostname}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: oauth2-proxy
                port:
                  number: 4180
  tls:
    - hosts:
        - ${cfg.hostname}
      secretName: oauth2-proxy-tls`,
  })
  await log('  OAuth2 Proxy (custom OIDC) deployed ✓')
}
