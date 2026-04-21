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

  if (middlewareType !== 'crowdsec' && middlewareType !== 'fail2ban') {
    return NextResponse.json({ error: 'Invalid middleware type' }, { status: 422 })
  }

  if (env.type === 'docker') {
    return NextResponse.json({ error: 'CrowdSec and Fail2Ban require a Kubernetes environment' }, { status: 422 })
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
    case 'fail2ban':     await deployFail2Ban(gx, log); break
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

  // Ensure namespace has PodSecurity bypass annotation (Talos defaults to restricted policy)
  // Always apply — updates annotations even if namespace already exists
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Namespace
metadata:
  name: crowdsec
  annotations:
    pod-security.kubernetes.io/enforce: "privileged"
    pod-security.kubernetes.io/audit: "privileged"
    pod-security.kubernetes.io/warn: "privileged"`,
  })

  const valuesFile = `agent:
  acquisition:
    - namespace: ".+"
      podName: ".*"
      program: "containerlog"
      poll_without_inotify: true
  image:
    repository: docker.io/crowdsec/crowdsec
crowdsec:
  config:
    piers:
      - storage:
          type: sqlite
traefik:
  enabled: "true"
  image:
    repository: docker.io/traefik/mb
metrics:
  enabled: "true"
`

  await log('Installing CrowdSec via Helm...')
  await gx('helm_upgrade_install', {
    release: 'crowdsec', chart: 'crowdsec', repo: 'https://crowdsecurity.github.io/helm-charts',
    namespace: 'crowdsec', createNamespace: false, valuesFile, wait: false, timeout: '300s',
  })
  await log('  CrowdSec installed ✓')

  await log('Creating Traefik bouncer...')
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: crowdsec-traefik-bouncer
  namespace: crowdsec
---
apiVersion: apps/v1
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
      serviceAccountName: crowdsec-traefik-bouncer
      containers:
        - name: bouncer
          image: docker.io/fbonalair/traefik-crowdsec-bouncer:latest
          env:
            - name: CROWDSEC_BOUNCER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: crowdsec-traefik-bouncer
                  key: api_key
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
apiVersion: v1
kind: Secret
metadata:
  name: crowdsec-traefik-bouncer
  namespace: crowdsec
type: Opaque
stringData:
  api_key: ""`,
  })
  await log('  Traefik bouncer deployed ✓')
}

async function deployFail2Ban(gx: (tool: string, args: Record<string, unknown>) => Promise<string>, log: JobLogger): Promise<void> {
  if (await kubectlExists(gx, 'daemonset', 'fail2ban', 'kube-system')) {
    await log('  Fail2Ban already installed ✓')
    return
  }

  await log('Deploying Fail2Ban DaemonSet for Kubernetes...')

  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fail2ban
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: fail2ban
  template:
    metadata:
      labels:
        app: fail2ban
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: fail2ban
          image: ghcr.io/anthonyfue/fail2ban-k8s:latest
          securityContext:
            privileged: true
            capabilities:
              add:
                - NET_ADMIN
                - NET_RAW
                - SYS_ADMIN
              drop:
                - ALL
          volumeMounts:
            - name: fail2ban-config
              mountPath: /etc/fail2ban
            - name: fail2ban-data
              mountPath: /var/lib/fail2ban
            - name: var-log
              mountPath: /var/log
              readOnly: true
            - name: run-nft
              mountPath: /run/nftables
      volumes:
        - name: fail2ban-config
          configMap:
            name: fail2ban-config
        - name: fail2ban-data
          emptyDir: {}
        - name: var-log
          hostPath:
            path: /var/log
            type: DirectoryOrCreate
        - name: run-nft
          emptyDir: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: fail2ban-config
  namespace: kube-system
data:
  fail2ban.local: |
    [DEFAULT]
    ignoreip = 127.0.0.1/8 ::1
    bantime  = 3600
    findtime = 600
    maxretry = 5
    backend = auto
  jail.local: |
    [traefik]
    enabled = true
    filter = traefik
    logpath = /var/log/kern.log
    maxretry = 5`,
  })
  await log('  Fail2Ban DaemonSet deployed ✓')
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
