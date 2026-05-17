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
  const middlewareType = String(body.middlewareType ?? 'crowdsec')

  if (middlewareType !== 'crowdsec') {
    return NextResponse.json({ error: 'Invalid middleware type' }, { status: 422 })
  }

  if (env.type === 'docker') {
    return NextResponse.json({ error: 'CrowdSec requires a Kubernetes environment' }, { status: 422 })
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
    `Bootstrap middleware (${middlewareType})`,
    { environmentId: env.id, metadata: { middlewareType, useGateway, useLocal } },
    async log => {
      if (useGateway) {
        await log(`Using gateway at ${gwUrl} for cluster operations`)
        const gc = new GatewayClient(gwUrl!, gwToken!)
        await bootstrapMiddleware(gwExecFn(gc), log, { type: middlewareType })
      } else {
        await log(`Using local kubectl (stored kubeconfig) for cluster operations`)
        const localKubectl = makeKubectlRunner(env.kubeconfig!)
        await bootstrapMiddleware(localKubectl, log, { type: middlewareType })
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
  cfg: { type: string },
): Promise<void> {
  await log(`Deploying ${cfg.type} infrastructure middleware`)

  switch (cfg.type) {
    case 'crowdsec':     await deployCrowdSec(gx, log); break
    default:
      throw new Error(`Unknown middleware type: ${cfg.type}`)
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
`

  await log('Installing CrowdSec via Helm...')
  await gx('helm_upgrade_install', {
    release: 'crowdsec', chart: 'crowdsec', repo: 'https://crowdsecurity.github.io/helm-charts',
    namespace: 'crowdsec', createNamespace: false, valuesFile, wait: false, timeout: '300s',
  })
  await log('  CrowdSec Helm release installed ✓')

  // Generate a bouncer API key via cscli inside the LAPI pod, then deploy the bouncer
  await log('Registering Traefik bouncer API key with CrowdSec LAPI...')
  await log('  NOTE: Run the following after pods are ready to get the API key:')
  await log('  kubectl exec -n crowdsec deploy/crowdsec-lapi -- cscli bouncers add traefik-bouncer -o raw')
  await log('  Then patch: kubectl create secret generic crowdsec-traefik-bouncer -n crowdsec --from-literal=api_key=<KEY> --dry-run=client -o yaml | kubectl apply -f -')

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
            - containerPort: 8068
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
      port: 8068
      targetPort: 8068
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: crowdsec-bouncer
  namespace: security
spec:
  forwardAuth:
    address: http://crowdsec-traefik-bouncer.crowdsec.svc.cluster.local:8068/api/v1/forwardAuth
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
