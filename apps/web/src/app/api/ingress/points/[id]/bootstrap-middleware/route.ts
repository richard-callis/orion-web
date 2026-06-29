/**
 * POST /api/ingress/points/:id/bootstrap-middleware
 *
 * Bootstraps infrastructure middleware (CrowdSec, Fail2Ban) into the
 * associated Kubernetes environment.
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
import { getNova } from '@/lib/nebula'

// Nova config shape for Nebula-sourced middleware
interface MiddlewareNovaConfig {
  name: string
  displayName: string
  namespaceLabels?: Record<string, Record<string, string>>
  helm?: {
    chart: string
    repo?: string
    namespace: string
    createNamespace?: boolean
    values?: { raw: string }
  }
  manifests?: string[]
  setupNote?: string
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const point = await prisma.ingressPoint.findUnique({
    where: { id: (await params).id },
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
  // Accept novaName (new) or middlewareType (backwards compat)
  const novaName = String(body.novaName ?? body.middlewareType ?? 'crowdsec')

  if (!novaName) {
    return NextResponse.json({ error: 'novaName is required' }, { status: 422 })
  }

  if (env.type === 'docker') {
    return NextResponse.json({ error: 'Middleware bootstrap requires a Kubernetes environment' }, { status: 422 })
  }

  // Determine execution mode: gateway first, fallback to local kubeconfig
  const gwUrl = env.gatewayUrl
  const gwToken = env.gatewayToken
  const hasKubeconfig = Boolean(env.kubeconfig)

  let useGateway = false
  let useLocal = false

  if (gwUrl && gwToken) {
    try {
      const res = await fetch(`${gwUrl}/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
        body: JSON.stringify({ name: 'kubectl_get_nodes', arguments: { wide: false } }),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) useGateway = true
    } catch { /* unreachable */ }
  }

  if (!useGateway && hasKubeconfig) {
    useLocal = true
  }

  if (!useGateway && !useLocal) {
    if (gwUrl && gwToken) {
      return NextResponse.json({ error: `Gateway at ${gwUrl} is not reachable and no kubeconfig is stored.` }, { status: 422 })
    }
    return NextResponse.json({ error: 'No gateway available and no kubeconfig stored for this environment.' }, { status: 422 })
  }

  const jobId = await startJob(
    'bootstrap-middleware',
    `Bootstrap middleware (${novaName})`,
    { environmentId: env.id, metadata: { novaName, useGateway, useLocal } },
    async log => {
      if (useGateway) {
        await log(`Using gateway at ${gwUrl} for cluster operations`)
        const gc = new GatewayClient(gwUrl!, gwToken!)
        await bootstrapMiddleware(gwExecFn(gc), log, { novaName })
      } else {
        await log(`Using local kubectl (stored kubeconfig) for cluster operations`)
        const localKubectl = makeKubectlRunner(env.kubeconfig!)
        await bootstrapMiddleware(localKubectl, log, { novaName })
      }
    },
  )

  return NextResponse.json({ jobId })
}

function gwExecFn(gc: GatewayClient) {
  return (tool: string, args: Record<string, unknown>) => gc.executeTool(tool, args)
}

async function bootstrapMiddleware(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { novaName: string },
): Promise<void> {
  await log(`Deploying middleware: ${cfg.novaName}`)

  // crowdsec retains its existing dedicated implementation for backwards compat
  if (cfg.novaName === 'crowdsec') {
    await deployCrowdSec(gx, log)
    return
  }

  // All other Novas: DB first, then bundled/remote via getNova().
  // Only middleware-tagged Novas are accepted — this prevents SSO provider configs
  // (which have a different helm shape) from being accidentally routed here.
  const nova = await prisma.nova.findUnique({ where: { name: cfg.novaName } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let novaConfig: any = nova?.config
  if (!novaConfig) {
    const resolved = await getNova(cfg.novaName)
    if (!resolved?.tags.includes('middleware')) {
      throw new Error(`Nova "${cfg.novaName}" not found in middleware catalog`)
    }
    novaConfig = resolved.config
  }

  await deployFromNovaConfig(gx, log, novaConfig as MiddlewareNovaConfig)
}

async function deployFromNovaConfig(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  config: MiddlewareNovaConfig,
): Promise<void> {
  const { name, displayName, namespaceLabels, helm, manifests, setupNote } = config

  // Apply namespace labels
  if (namespaceLabels) {
    for (const [ns, labels] of Object.entries(namespaceLabels)) {
      await log(`Ensuring namespace ${ns} with required labels…`)
      const labelLines = Object.entries(labels).map(([k, v]) => `    ${k}: "${v}"`).join('\n')
      await gx('kubectl_apply_manifest', {
        manifest: `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n  labels:\n${labelLines}`,
      })
      await log(`  Namespace ${ns} ready ✓`)
    }
  }

  // Helm install
  if (helm) {
    await log(`Installing ${displayName ?? name} via Helm…`)
    await gx('helm_upgrade_install', {
      release: name,
      chart: helm.chart,
      repo: helm.repo,
      namespace: helm.namespace,
      createNamespace: helm.createNamespace ?? false,
      // Pass raw YAML values string through valuesFile param
      valuesFile: helm.values?.raw,
      wait: false,
      timeout: '300s',
    })
    await log(`  Helm release installed ✓`)
  }

  // Post-install manifests
  if (manifests?.length) {
    await log('Applying post-install manifests…')
    for (const manifest of manifests) {
      await gx('kubectl_apply_manifest', { manifest })
    }
    await log('  Manifests applied ✓')
  }

  if (setupNote) {
    await log(`\nSetup note:\n${setupNote}`)
  }
}

async function kubectlExists(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  kind: string, name: string, namespace?: string,
): Promise<boolean> {
  try {
    await gx('kubectl_get', { resource: kind.toLowerCase(), name, ...(namespace ? { namespace } : {}) })
    return true
  } catch { return false }
}

async function deployCrowdSec(gx: (tool: string, args: Record<string, unknown>) => Promise<string>, log: JobLogger): Promise<void> {
  // Check if already installed by looking for the Helm release secret
  try {
    const result = await gx('kubectl_get', { resource: 'secret', namespace: 'crowdsec', output: 'json' })
    const secrets = JSON.parse(result || '{}')
    const hasHelmRelease = (secrets.items || []).some((s: any) =>
      (s.metadata?.labels || {}).release === 'crowdsec',
    )
    if (hasHelmRelease) {
      await log('  CrowdSec already installed ✓')
      return
    }
  } catch { /* not installed yet */ }

  // Ensure namespace exists with PodSecurity labels set to privileged.
  // Talos enforces baseline by default — agents need hostPath volumes so require privileged.
  // Must use labels (not annotations) — PodSecurity admission reads labels only.
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Namespace
metadata:
  name: crowdsec
  labels:
    pod-security.kubernetes.io/enforce: "privileged"
    pod-security.kubernetes.io/audit: "privileged"
    pod-security.kubernetes.io/warn: "privileged"`,
  })
  await log('  Namespace crowdsec ready with privileged PodSecurity labels ✓')

  // Generate a random API key so the bouncer secret and LAPI registration are
  // both set before any pods start — no manual cscli step needed.
  const bouncerApiKey = require('crypto').randomBytes(32).toString('hex')

  // Create the secret first so the bouncer deployment never hits a missing-secret error.
  await log('Creating Traefik bouncer API key secret...')
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Secret
metadata:
  name: crowdsec-traefik-bouncer
  namespace: crowdsec
type: Opaque
stringData:
  api_key: "${bouncerApiKey}"`,
  })
  await log('  Secret crowdsec-traefik-bouncer created ✓')

  // Pass the same key to the LAPI via BOUNCER_KEY_* env var so CrowdSec
  // auto-registers it on startup — identical to the K3s approach.
  const valuesFile = `agent:
  acquisition:
    - namespace: kube-system
      podName: ".*"
      program: containerlog
    - namespace: apps
      podName: ".*"
      program: containerlog
    - namespace: security
      podName: ".*"
      program: containerlog
    - namespace: management
      podName: ".*"
      program: containerlog
lapi:
  dashboard:
    enabled: false
  env:
    - name: BOUNCER_KEY_traefik-bouncer
      value: "${bouncerApiKey}"
`

  await log('Installing CrowdSec via Helm...')
  await gx('helm_upgrade_install', {
    release: 'crowdsec', chart: 'crowdsec', repo: 'https://crowdsecurity.github.io/helm-charts',
    namespace: 'crowdsec', createNamespace: false, valuesFile, wait: false, timeout: '300s',
  })
  await log('  CrowdSec Helm release installed ✓')

  await log('Deploying Traefik bouncer...')
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: crowdsec-traefik-bouncer
  namespace: crowdsec
spec:
  replicas: 1
  selector:
    matchLabels:
      app: crowdsec-traefik-bouncer
  template:
    metadata:
      labels:
        app: crowdsec-traefik-bouncer
    spec:
      containers:
        - name: bouncer
          image: docker.io/fbonalair/traefik-crowdsec-bouncer:latest
          env:
            - name: CROWDSEC_BOUNCER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: crowdsec-traefik-bouncer
                  key: api_key
            - name: CROWDSEC_AGENT_HOST
              value: crowdsec-service.crowdsec.svc.cluster.local:8080
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: crowdsec-traefik-bouncer
  namespace: crowdsec
spec:
  selector:
    app: crowdsec-traefik-bouncer
  ports:
    - name: http
      port: 8080
      targetPort: 8080
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: crowdsec-bouncer
  namespace: security
spec:
  forwardAuth:
    address: http://crowdsec-traefik-bouncer.crowdsec.svc.cluster.local:8080/api/v1/forwardAuth
    trustForwardHeader: true`,
  })
  await log('  Traefik bouncer deployed ✓')
  await log('  Middleware security-crowdsec-bouncer@kubernetescrd created ✓')
}

// ── Local kubectl runner (fallback when gateway unavailable) ──────────────────

function makeKubectlRunner(kubeconfig: string) {
  const tmpDir = `/tmp/orion-kubectl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { mkdirSync, writeFileSync } = require('fs')

  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(`${tmpDir}/kubeconfig`, Buffer.from(kubeconfig, 'base64').toString('utf8'), { mode: 0o600 })
  } catch { /* best effort */ }

  return async function kubectlTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'kubectl_apply_manifest') {
      const manifest = String(args.manifest)
      const tmpPath = `${tmpDir}/manifest-${Date.now()}.yaml`
      try {
        writeFileSync(tmpPath, manifest, { mode: 0o600 })
        const { execFile } = require('child_process')
        const { promisify } = require('util')
        const exec = promisify(execFile)
        const { stdout } = await exec('kubectl', ['apply', '-f', tmpPath, '--kubeconfig', `${tmpDir}/kubeconfig`], { timeout: 60_000 })
        return stdout
      } catch (e: unknown) {
        throw new Error(`kubectl apply failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (name === 'helm_repo_add' || name === 'helm_upgrade_install') {
      const { execFile } = require('child_process')
      const { unlinkSync } = require('fs')
      const { promisify } = require('util')
      const exec = promisify(execFile)

      try {
        let cmd: string[]
        if (name === 'helm_repo_add') {
          cmd = ['repo', 'add', args.name as string, args.url as string]
        } else {
          cmd = ['upgrade', '--install', args.release as string, args.chart as string, '--kubeconfig', `${tmpDir}/kubeconfig`]
          if (args.repo && String(args.repo).startsWith('http')) {
            cmd.push('--repo', args.repo as string)
          }
          cmd.push('--namespace', args.namespace as string, '--timeout', String(args.timeout ?? '120s'))
          if (args.createNamespace) cmd.push('--create-namespace')
          if (args.wait !== false) cmd.push('--wait')
          // Handle valuesFile (YAML string for complex/nested values including arrays)
          if (args.valuesFile) {
            const tmpPath = `${tmpDir}/helm-values-${Date.now()}.yaml`
            writeFileSync(tmpPath, String(args.valuesFile), { mode: 0o600 })
            cmd.push('--values', tmpPath)
            try {
              const result = await exec('helm', cmd, { timeout: 600_000 })
              return result.stdout
            } finally {
              try { unlinkSync(tmpPath) } catch { /* ignore */ }
            }
          }
          const values = args.values as Record<string, unknown> | undefined
          if (values) {
            for (const [k, v] of Object.entries(values)) {
              cmd.push('--set', `${k}=${v}`)
            }
          }
        }
        const result = await exec('helm', cmd, {
          timeout: name === 'helm_upgrade_install' ? 600_000 : 30_000,
        })
        return result.stdout
      } catch (e: unknown) {
        throw new Error(`helm failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Generic kubectl
    if (!name.startsWith('kubectl_')) return ''
    const cmd = name.substring(8)
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const exec = promisify(execFile)

    const flags: string[] = []
    for (const [key, val] of Object.entries(args)) {
      if (key === 'manifest') continue
      if (key === 'namespace') { flags.push('-n'); flags.push(String(val)) }
      else if (key === 'output') { flags.push(`-o${val === '' ? '' : val}`) }
      else { flags.push(`--${key.replace(/_/g, '-')}`); flags.push(String(val)) }
    }

    try {
      const { stdout } = await exec('kubectl', [cmd, ...Object.values(args).filter(v => typeof v === 'string').filter(s => !s.includes('/')) || [String(args.name)], ...flags, '--kubeconfig', `${tmpDir}/kubeconfig`], { timeout: 30_000 })
      return stdout
    } catch (e: unknown) {
      throw new Error(`kubectl ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
