/**
 * Cluster Bootstrap
 *
 * Bootstraps a newly registered K8s environment:
 *   1.  Write kubeconfig to a temp file
 *   2.  Verify cluster connectivity
 *   3.  Ensure Gitea repo exists for this environment
 *   4.  Register cluster with local ArgoCD (REST API)
 *   5.  Configure ArgoCD (AppProject + Application → Gitea repo /deployments)
 *   6.  Deploy Gateway via kubectl apply
 *   7.  Create Vault AppRole + policy scoped to this environment
 *   8.  Install External Secrets Operator via Helm
 *   9.  Apply ClusterSecretStore pointing to ORION Vault
 *   10. Update environment record + clean up temp files
 */

import { spawn } from 'child_process'
import { writeFile, readFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from './db'
import { decrypt } from './encryption'
import { bootstrapEnvironmentRepo } from './gitops'
import { getGitProvider, getGitProviderConfig } from './git-provider'
import { VAULT_ADDR, vaultFetch } from './vault'

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? 'http://host.docker.internal:8083'
const ARGOCD_PASSWORD = process.env.ARGOCD_AUTH_TOKEN
const TALEOS_KUBECONFIG_PATH = process.env.TALOS_KUBECONFIG ?? '/root/.kube/config'

// ── ArgoCD API helpers ────────────────────────────────────────────────────────

async function argocdLogin(): Promise<string> {
  if (!ARGOCD_PASSWORD) return ''
  const res = await fetch(`${ARGOCD_SERVER}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ARGOCD_PASSWORD }),
  })
  if (!res.ok) {
    console.warn(`[bootstrap] ArgoCD login failed: ${res.status} ${res.statusText}`)
    return ''
  }
  const data = await res.json()
  return data.token ?? ''
}

async function argocdPut(token: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${ARGOCD_SERVER}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[bootstrap] ArgoCD PUT ${path} failed: ${res.status} ${body.slice(0, 200)}`)
  }
}

/** Extract API server URL from kubeconfig YAML string. */
function extractKubeconfigServer(kubeconfig: string): string | null {
  const match = kubeconfig.match(/clusters:\s*\n\s*-+[^-]*?server:\s*(https?:\/\/[^\s]+)/s)
  return match?.[1]?.trim() ?? null
}

/** Register the Talos cluster with the local ArgoCD server. */
async function argocdRegisterCluster(token: string, envName: string): Promise<void> {
  if (!token) return
  // Read the Talos kubeconfig
  const kubeconfig = await readFile('/root/.kube/config', 'utf-8').catch(() => '')
  if (!kubeconfig) {
    console.warn('[bootstrap] No kubeconfig found — skipping cluster registration')
    return
  }

  const clusterServer = extractKubeconfigServer(kubeconfig)
  if (!clusterServer) {
    console.warn('[bootstrap] Could not parse API server URL from kubeconfig — skipping cluster registration')
    return
  }

  const slug = envName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const clusterName = `${slug}-cluster`

  // Create cluster via ArgoCD API (cluster resource stored as a secret)
  await argocdPut(token, '/api/v1/clusters', {
    secretType: 'kubernetes',
    metadata: {
      name: clusterName,
      namespace: 'argocd',
      labels: { 'argocd.argoproj.io/secret-type': 'cluster' },
    },
    stringData: {
      name: clusterName,
      server: clusterServer,
      config: kubeconfig,
    },
  })
  console.log(`[bootstrap] Registered cluster "${clusterName}" (API: ${clusterServer})`)
}

/** Create the root Application and AppProject in ArgoCD. */
async function argocdConfigureApp(token: string, envName: string, repoUrl: string, clusterServer: string): Promise<void> {
  if (!token) return
  const slug = envName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // AppProject
  await argocdPut(token, `/api/v1/appprojects/${slug}`, {
    metadata: {
      name: slug,
      namespace: 'argocd',
    },
    spec: {
      description: `ORION-managed cluster: ${envName}`,
      sourceRepos: [repoUrl],
      destinations: [{ namespace: '*', server: clusterServer }],
      clusterResourceWhitelist: [{ group: '*', kind: '*' }],
    },
  })

  // Application
  await argocdPut(token, `/api/v1/applications/${slug}`, {
    metadata: {
      name: slug,
      namespace: 'argocd',
      annotations: {
        'argocd.argoproj.io/sync-wave': '0',
      },
    },
    spec: {
      project: slug,
      source: {
        repoURL: repoUrl,
        targetRevision: 'main',
        path: 'deployments',
        directory: { recurse: true },
      },
      destination: {
        server: clusterServer,
        namespace: 'default',
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ['CreateNamespace=true'],
      },
    },
  })
  console.log(`[bootstrap] Configured ArgoCD app "${slug}" → ${repoUrl}/deployments`)
}

// ── Docker environment helpers ──────────────────────────────────────────────────

interface HostConnection {
  host: string        // hostname or IP
  port?: number       // SSH port (default 22)
  user: string        // SSH user
  keyPath?: string    // path to SSH key (or use SSH agent)
}

/**
 * Validate values that will be interpolated into remote shell commands via SSH/SCP.
 * These fields come from user-supplied environment metadata; without validation
 * a crafted value like user='-oProxyCommand=...' causes SSH option injection,
 * and remotePath='/opt; rm -rf /' causes RCE on the remote host.
 */
function validateSshField(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name} value '${value}' — must match ${pattern}`)
  }
  return value
}

/** Parse host connection from environment metadata. */
function parseHostConnection(env: { metadata: unknown; id: string }): HostConnection {
  const meta = env.metadata as Record<string, unknown> | undefined
  const rawHost  = (meta?.host     as string) ?? 'localhost'
  const rawUser  = (meta?.sshUser  as string) ?? 'root'
  const rawPort  = Number((meta?.sshPort as unknown) ?? 22)
  const keyPath  = meta?.sshKeyPath as string | undefined

  // Validate sshKeyPath contains only safe path characters
  const SSH_KEY_PATH_RE = /^[a-zA-Z0-9/_.-]+$/
  if (keyPath && !SSH_KEY_PATH_RE.test(keyPath)) {
    throw new Error('Invalid sshKeyPath')
  }

  // Validate before interpolating into SSH/SCP commands
  const host = validateSshField(rawHost,  'host',    /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
  const user = validateSshField(rawUser,  'sshUser', /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$/)
  if (!Number.isFinite(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error(`Invalid sshPort: ${rawPort}`)
  }
  const port = rawPort
  return { host, port, user, keyPath }
}

/** Sync deployment files from local temp dir to remote host via SCP. */
async function syncFilesToHost(
  connection: HostConnection,
  tmpDir: string,
  remotePath: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const scpCmd = [
    'scp', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-r', `${tmpDir}/deployments/`,
    `${connection.user}@${connection.host}:${remotePath}/`,
  ]
  if (connection.port) scpCmd.splice(scpCmd.indexOf(`${connection.user}@${connection.host}:${remotePath}/`), 0, '-P', String(connection.port))
  if (connection.keyPath) scpCmd.splice(scpCmd.indexOf('-o'), 0, '-i', connection.keyPath)

  await runCommand(scpCmd[0], scpCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
}

/** Deploy Docker Compose services to a single Docker host. */
async function deployDockerCompose(
  connection: HostConnection,
  remotePath: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // Run docker-compose up -d on the remote host
  const sshCmd = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-t', `${connection.user}@${connection.host}`,
    // remotePath validated: must not contain shell metacharacters to prevent RCE
    `cd ${validateSshField(remotePath, 'remotePath', /^[a-zA-Z0-9/_.-]{1,256}$/)} && docker compose up -d`,
  ]
  if (connection.port) sshCmd.splice(sshCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

  await runCommand('ssh', sshCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
}

// ── Docker Swarm helpers ──────────────────────────────────────────────────────────

interface SwarmNode {
  nodeId: string
  host: string
  role: 'manager' | 'worker'
}

/** Initialize Docker Swarm and add managers/workers. */
async function setupDockerSwarm(
  connection: HostConnection,
  nodes: SwarmNode[],
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // Step 1: Manager initializes swarm
  emit({ type: 'step', message: 'Initializing Docker Swarm on manager...' })
  const initCmd = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-t', `${connection.user}@${connection.host}`,
    'docker swarm init --advertise-addr eth0',
  ]
  if (connection.port) initCmd.splice(initCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

  await runCommand('ssh', initCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))

  // Step 2: Get join tokens
  emit({ type: 'step', message: 'Retrieving swarm join tokens...' })
  const managerTokenRes = await runQuiet(
    'ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-t', `${connection.user}@${connection.host}`,
      'docker swarm join-token manager -q',
    ],
    {},
  )
  const workerTokenRes = await runQuiet(
    'ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-t', `${connection.user}@${connection.host}`,
      'docker swarm join-token worker -q',
    ],
    {},
  )

  const managerToken = managerTokenRes.out.trim()
  const workerToken = workerTokenRes.out.trim()

  // Step 3: Join additional managers and workers
  for (const node of nodes) {
    // BLOCKER fix: node.host and node.nodeId come from env.metadata (user-supplied) and were
    // used directly in SSH target and docker label commands without validation.
    // A crafted host like '-oProxyCommand=...' yields SSH option injection; a crafted
    // nodeId like 'x; rm -rf /' yields shell injection in the docker node update command.
    // Validate both through the same validateSshField function used for the manager host.
    let safeNodeHost: string
    let safeNodeId: string
    try {
      safeNodeHost = validateSshField(node.host, 'node.host', /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
      safeNodeId   = validateSshField(node.nodeId, 'node.nodeId', /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/)
    } catch (e) {
      console.error(`[bootstrap] Skipping swarm node with invalid host/nodeId: ${e}`)
      emit({ type: 'log', message: `Skipped node with invalid host/nodeId: ${e}` })
      continue
    }

    const isManager = node.role === 'manager'
    const token = isManager ? managerToken : workerToken
    if (!token) {
      console.warn(`[bootstrap] No join token for node ${node.nodeId} — skipping`)
      continue
    }

    emit({ type: 'step', message: `Joining ${node.role} node ${safeNodeHost}...` })
    const joinCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${safeNodeHost}`,
      `docker swarm join --token "${token}" ${connection.host}:2377`,
    ]
    if (connection.port) joinCmd.splice(joinCmd.indexOf(`${connection.user}@${safeNodeHost}`), 0, '-p', String(connection.port))

    await runCommand('ssh', joinCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
  }

  // Step 4: Label nodes
  emit({ type: 'step', message: 'Labeling swarm nodes...' })
  for (const node of nodes) {
    let safeHost: string
    let safeId: string
    try {
      safeHost = validateSshField(node.host, 'node.host', /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
      safeId   = validateSshField(node.nodeId, 'node.nodeId', /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/)
    } catch {
      continue
    }
    const labelCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${safeHost}`,
      `docker node update --label-add orion/env=${connection.user} ${safeId}`,
    ]
    if (connection.port) labelCmd.splice(labelCmd.indexOf(`${connection.user}@${safeHost}`), 0, '-p', String(connection.port))

    await runCommand('ssh', labelCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
  }

  console.log(`[bootstrap] Docker Swarm initialized: ${nodes.length} nodes`)
}

/** Deploy a stack to Docker Swarm using compose files from the repo. */
async function deploySwarmStack(
  connection: HostConnection,
  repoUrl: string,
  stackName: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(stackName)) {
    throw new Error(`Invalid stack name: ${stackName}`)
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.host)) {
    throw new Error(`Invalid host: ${connection.host}`)
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.user)) {
    throw new Error(`Invalid user: ${connection.user}`)
  }
  // Clone the repo locally (needed for docker stack deploy which reads compose files)
  const stackDir = join(tmpdir(), `orion-swarm-${randomBytes(4).toString('hex')}`)
  await mkdir(stackDir, { recursive: true })

  try {
    emit({ type: 'step', message: 'Checking out deployment files...' })
    // Validate repoUrl is a safe http(s) URL before cloning
    let parsedRepoUrl: URL
    try { parsedRepoUrl = new URL(repoUrl) } catch { throw new Error(`Invalid repo URL: ${repoUrl}`) }
    if (parsedRepoUrl.protocol !== 'http:' && parsedRepoUrl.protocol !== 'https:') {
      throw new Error(`Repo URL must use http or https: ${repoUrl}`)
    }
    await runCommand(
      'git', ['clone', '--depth', '1', '--', repoUrl, stackDir],
      {},
      msg => emit({ type: 'log', message: msg }),
    )

    // docker stack deploy requires a compose file at a known path
    // Use the deployments/ directory if it exists, otherwise fall back to root
    const composePath = join(stackDir, 'deployments', 'docker-compose.yml')
    const fallbackComposePath = join(stackDir, 'docker-compose.yml')

    const targetPath = (await readFile(composePath, 'utf8').catch(() => null))
      ? composePath : fallbackComposePath

    if (!targetPath) throw new Error('No docker-compose.yml found in repo')

    emit({ type: 'step', message: 'Deploying stack to Docker Swarm...' })

    // SCP compose file to swarm manager then run docker stack deploy
    const scpToManager = [
      'scp', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      targetPath, `${connection.user}@${connection.host}:/tmp/orion-stack-compose.yml`,
    ]
    if (connection.port) scpToManager.splice(scpToManager.indexOf(`${connection.user}@${connection.host}`), 0, '-P', String(connection.port))

    await runCommand(scpToManager[0], scpToManager.slice(1), {}, msg => emit({ type: 'log', message: msg }))

    // Run docker stack deploy on the manager
    const deployCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${connection.host}`,
      `docker stack deploy -c /tmp/orion-stack-compose.yml ${stackName}`,
    ]
    if (connection.port) deployCmd.splice(deployCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

    await runCommand('ssh', deployCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))

    console.log(`[bootstrap] Swarm stack "${stackName}" deployed`)
  } finally {
    await rm(stackDir, { recursive: true, force: true })
  }
}

const ORION_URL       = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  'http://localhost:3000'
).replace(/\/$/, '')
const MANAGEMENT_IP   = process.env.MANAGEMENT_IP ?? 'localhost'

export type BootstrapEvent =
  | { type: 'step'; message: string }
  | { type: 'log'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }

// ── Shell helpers ─────────────────────────────────────────────────────────────

/** Run a command and capture stdout+stderr without streaming to the caller. */
function runQuiet(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }))
    proc.on('error', (err) => resolve({ ok: false, out: err.message }))
  })
}

function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  onLog: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog)
    })
    proc.stderr.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog)
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

// ── Standalone monitoring deployment ─────────────────────────────────────────

export async function deployMonitoringStack(
  envId: string,
  stack: 'basic' | 'full',
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) throw new Error('Environment not found')
  if (env.type !== 'cluster') throw new Error('Monitoring deployment is only supported for Kubernetes environments')
  if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')

  const tmpDir = join(tmpdir(), `orion-monitoring-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const kubeconfigPath = join(tmpDir, 'kubeconfig')
  await writeFile(kubeconfigPath, Buffer.from(env.kubeconfig, 'base64').toString('utf8'), { mode: 0o600 })

  const kenv = { KUBECONFIG: kubeconfigPath, KUBECTL_CACHE_DIR: join(tmpDir, 'kubectl-cache') }

  try {
    emit({ type: 'step', message: 'Verifying cluster connectivity...' })
    await runCommand('kubectl', ['cluster-info'], kenv, msg => emit({ type: 'log', message: msg }))

    emit({ type: 'step', message: 'Creating monitoring namespace...' })
    await runQuiet('kubectl', ['create', 'namespace', 'monitoring'], kenv)

    if (stack === 'basic' || stack === 'full') {
      emit({ type: 'step', message: 'Deploying VictoriaMetrics (metrics & alerting)...' })
      await runCommand(
        'helm', [
          'upgrade', '--install', 'victoria-metrics-k8s-stack', 'victoriametrics/victoria-metrics-k8s-stack',
          '--namespace', 'victoria-metrics',
          '--create-namespace',
          '--wait',
          '--timeout', '5m',
          '--set', 'serverServiceEnabled=false',
          '--set', 'vmsingle.replicas=1',
        ],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      emit({ type: 'step', message: 'Deploying ntopng (network traffic analysis)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/ntopng/service.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    if (stack === 'full') {
      emit({ type: 'step', message: 'Deploying ELK stack (logs & flow analysis)...' })
      for (const manifest of [
        '/opt/orion/deploy/monitoring/elk/namespace.yaml',
        '/opt/orion/deploy/monitoring/elk/secret.yaml',
        '/opt/orion/deploy/monitoring/elk/elasticsearch-deployment.yaml',
        '/opt/orion/deploy/monitoring/elk/logstash-configmap.yaml',
        '/opt/orion/deploy/monitoring/elk/logstash-deployment.yaml',
        '/opt/orion/deploy/monitoring/elk/kibana-deployment.yaml',
      ]) {
        await runCommand('kubectl', ['apply', '-f', manifest], kenv, msg => emit({ type: 'log', message: msg }))
      }

      emit({ type: 'step', message: 'Deploying Elastiflow (NetFlow collector)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elastiflow/deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    const namespacesToWait = stack === 'full'
      ? ['victoria-metrics', 'monitoring', 'elk']
      : ['victoria-metrics', 'monitoring']

    emit({ type: 'step', message: 'Waiting for monitoring pods to become ready...' })
    for (const ns of namespacesToWait) {
      try {
        await runCommand(
          'kubectl', ['wait', '--for=condition=Ready', '--all', '-n', ns, '--timeout=300s', 'pods'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
      } catch {
        emit({ type: 'log', message: `Some pods in ${ns} not ready yet — continuing` })
      }
    }

    await prisma.environment.update({
      where: { id: envId },
      data: { monitoringConfig: { stack } },
    })

    emit({ type: 'done', message: `Monitoring stack (${stack}) deployed successfully.` })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── ArgoCD manifests ──────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
}

// ── Gateway manifest ──────────────────────────────────────────────────────────

function gatewayManifest(envName: string, joinToken: string): string {
  const slug = envName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const image = `ghcr.io/${process.env.GITHUB_ORG ?? 'richard-callis'}/orion-gateway:latest`

  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: orion-management
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orion-gateway
  namespace: orion-management
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: orion-gateway-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: orion-management
---
# Allows the gateway to write its registered credentials back to the Secret
# so they survive pod restarts without needing a PVC.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
rules:
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["orion-gateway-credentials"]
  verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orion-gateway-credentials
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: orion-management
---
apiVersion: v1
kind: Secret
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
stringData:
  join-token: "${joinToken}"
  orion-url: "${ORION_URL}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orion-gateway
  namespace: orion-management
  labels:
    app: orion-gateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: orion-gateway
  template:
    metadata:
      labels:
        app: orion-gateway
    spec:
      serviceAccountName: orion-gateway
      containers:
        - name: gateway
          image: ${image}
          imagePullPolicy: Always
          ports:
            - containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            - name: GATEWAY_TYPE
              value: "cluster"
            - name: ENV_NAME
              value: "${envName}"
            - name: GATEWAY_NAMESPACE
              value: "orion-management"
            - name: ORION_URL
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: orion-url
            - name: JOIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: join-token
            - name: GATEWAY_URL
              value: "http://orion-gateway.orion-management.svc.cluster.local:3001"
          livenessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: orion-gateway
  namespace: orion-management
spec:
  selector:
    app: orion-gateway
  ports:
    - port: 3001
      targetPort: 3001
`
}

// ── ESO + Vault manifests ─────────────────────────────────────────────────────

interface TLSConfig {
  caBundleB64: string
  clientCertPem: string
  clientKeyPem: string
}

function esoVaultManifest(
  roleId: string,
  secretId: string,
  vaultAddr: string,
  tls?: TLSConfig,
): string {
  const hasMTLS = tls && tls.clientCertPem && tls.clientKeyPem

  const tlsSection = tls ? `
      caBundle: "${tls.caBundleB64}"` + (hasMTLS ? `
      tls:
        certSecretRef:
          name: orion-vault-client-tls
          namespace: external-secrets
          key: tls.crt
        keySecretRef:
          name: orion-vault-client-tls
          namespace: external-secrets
          key: tls.key` : '') : ''

  const clientCertSecret = hasMTLS ? `---
apiVersion: v1
kind: Secret
metadata:
  name: orion-vault-client-tls
  namespace: external-secrets
stringData:
  tls.crt: |
${tls.clientCertPem.split('\n').map(l => `    ${l}`).join('\n')}
  tls.key: |
${tls.clientKeyPem.split('\n').map(l => `    ${l}`).join('\n')}
` : ''

  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: external-secrets
---
apiVersion: v1
kind: Secret
metadata:
  name: orion-vault-approle
  namespace: external-secrets
stringData:
  roleId: "${roleId}"
  secretId: "${secretId}"
${clientCertSecret}---
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: orion-vault
spec:
  provider:
    vault:
      server: "${vaultAddr}"
      path: "secret"
      version: "v2"${tlsSection}
      auth:
        appRole:
          path: "approle"
          roleId: "${roleId}"
          secretRef:
            name: orion-vault-approle
            namespace: external-secrets
            key: secretId
`
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

async function vaultRequest(
  path: string,
  token: string,
  method: string = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await vaultFetch(`${VAULT_ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = res.status !== 204 ? await res.json().catch(() => ({})) : {}
  return { ok: res.ok, status: res.status, data }
}

// ── mTLS client cert generation ───────────────────────────────────────────────

const VAULT_PROXY_CERTS_DIR = '/vault-proxy-certs'

/** Generate a per-cluster client cert signed by the vault-proxy CA. */
async function generateClientCert(
  envName: string,
  tmpDir: string,
): Promise<{ certPem: string; keyPem: string } | null> {
  const caKeyPath  = join(VAULT_PROXY_CERTS_DIR, 'ca.key')
  const caCertPath = join(VAULT_PROXY_CERTS_DIR, 'ca.crt')

  // Check CA key is accessible (proxy may not be set up yet)
  const caKey = await readFile(caKeyPath, 'utf8').catch(() => null)
  if (!caKey) return null

  const keyPath  = join(tmpDir, `${envName}-client.key`)
  const csrPath  = join(tmpDir, `${envName}-client.csr`)
  const certPath = join(tmpDir, `${envName}-client.crt`)
  const extPath  = join(tmpDir, `${envName}-client.ext`)
  // Use a random serial number rather than a serial file — avoids any writes to the
  // read-only /vault-proxy-certs mount that holds the CA key/cert.
  const serial   = randomBytes(8).toString('hex')

  await writeFile(extPath, [
    '[req_ext]',
    'subjectAltName = @alt_names',
    '[alt_names]',
    `DNS.1 = eso-${envName}`,
  ].join('\n'))

  const steps: Array<[string, string[]]> = [
    ['openssl', ['genrsa', '-out', keyPath, '4096']],
    ['openssl', ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=eso-${envName}/O=ORION`]],
    ['openssl', ['x509', '-req', '-days', '3650',
      '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath,
      '-set_serial', `0x${serial}`, '-out', certPath, '-extfile', extPath, '-extensions', 'req_ext']],
  ]

  for (const [cmd, args] of steps) {
    const result = await runQuiet(cmd, args, {})
    if (!result.ok) throw new Error(`Client cert generation failed (${cmd}): ${result.out}`)
  }

  const [certPem, keyPem] = await Promise.all([
    readFile(certPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ])
  return { certPem, keyPem }
}

// ── Common bootstrap logic (shared across environment types) ────────────────────

interface GitRepoInfo {
  owner: string
  repo: string
  url: string
  healthy: boolean
}

/** Ensure a git repo exists for this environment. Returns repo info or null. */
async function ensureGitRepo(env: { name: string; gitOwner: string | null; gitRepo: string | null; id: string }, emit: (event: BootstrapEvent) => void): Promise<GitRepoInfo | null> {
  const gitOwner = env.gitOwner ?? 'orion'
  const gitRepo  = env.gitRepo  ?? env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const orionUrl = ORION_URL.replace(/\/$/, '')

  const provider = await getGitProvider()
  const providerHealthy = await provider.isHealthy()

  let resolvedGitOwner = gitOwner
  if (!providerHealthy) {
    emit({ type: 'log', message: 'Git provider not reachable — skipping repo creation (will retry on next bootstrap)' })
    return { owner: resolvedGitOwner, repo: gitRepo, url: '', healthy: false }
  }

  try {
    const createdRepo = await bootstrapEnvironmentRepo({
      owner: gitOwner,
      repoName: gitRepo,
      description: `ORION-managed environment: ${env.name}`,
      webhookUrl: `${orionUrl}/api/webhooks/gitea`,
      webhookSecret: randomBytes(32).toString('hex'),
    })
    resolvedGitOwner = createdRepo.fullName.split('/')[0]
    // Build the cluster-reachable clone URL — must match the base URL registered in
    // the ArgoCD credential Secret by argocd-bootstrap.ts so ArgoCD can find credentials.
    // getPRUrl() uses publicUrl (Cloudflare/HTTPS), which ArgoCD can't match. Use the
    // internal URL instead: management IP for bundled Gitea, config.url for external.
    const gitCfg = await getGitProviderConfig()
    const internalBase = gitCfg?.type === 'gitea-bundled'
      ? `http://${MANAGEMENT_IP}:3002`
      : (gitCfg?.url ?? 'https://github.com')
    const cloneUrl = `${internalBase.replace(/\/$/, '')}/${resolvedGitOwner}/${gitRepo}.git`
    emit({ type: 'log', message: `Git repo ready: ${createdRepo.htmlUrl}` })
    return { owner: resolvedGitOwner, repo: gitRepo, url: cloneUrl, healthy: true }
  } catch (err) {
    console.error(`[bootstrap] Failed to create repo: ${err}`)
    emit({ type: 'log', message: `Failed to create git repo: ${err instanceof Error ? err.message : String(err)}` })
    return null
  }
}

// ── K8s/Talos bootstrap ───────────────────────────────────────────────────────

/** Bootstrap a K8s/Talos cluster environment (original flow). */
async function bootstrapK8sCluster(
  env: NonNullable<Awaited<ReturnType<typeof prisma.environment.findUnique>>>,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const kubeconfigYaml = Buffer.from(env.kubeconfig, 'base64').toString('utf8')
  const kubeconfigPath = join(tmpDir, 'kubeconfig')
  await writeFile(kubeconfigPath, kubeconfigYaml, { mode: 0o600 })

  const kenv = { KUBECONFIG: kubeconfigPath, KUBECTL_CACHE_DIR: join(tmpDir, 'kubectl-cache') }
  const slug = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    // 1. Verify cluster connectivity
    emit({ type: 'step', message: 'Verifying cluster connectivity...' })
    await runCommand('kubectl', ['cluster-info'], kenv, msg => emit({ type: 'log', message: msg }))

    // 2. Ensure git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // 3. Register with local ArgoCD
    emit({ type: 'step', message: 'Registering with local ArgoCD...' })
    const argocdToken = await argocdLogin()
    if (argocdToken) {
      const clusterServer = extractKubeconfigServer(kubeconfigYaml)
      if (clusterServer) {
        await argocdRegisterCluster(argocdToken, env.name)
        if (gitInfo.healthy && argocdToken) {
          await argocdConfigureApp(argocdToken, env.name, gitInfo.url, clusterServer)
        }
      } else {
        emit({ type: 'log', message: 'Could not determine cluster API server — ArgoCD registration skipped' })
      }
    } else {
      emit({ type: 'log', message: 'ArgoCD not configured — skipping (will retry on next bootstrap)' })
    }

    // 4. Deploy Gateway
    emit({ type: 'step', message: 'Deploying ORION Gateway...' })
    const gwCheck = await runQuiet(
      'kubectl', ['get', 'deployment', 'orion-gateway', '-n', 'orion-management', '--ignore-not-found'],
      kenv,
    )
    if (gwCheck.out.includes('orion-gateway')) {
      emit({ type: 'log', message: 'Gateway already deployed — skipping' })
    } else {
      const token = `orion_${randomBytes(24).toString('hex')}`
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      await prisma.environmentJoinToken.create({
        data: { token, environmentId: env.id, expiresAt },
      })
      await writeFile(join(tmpDir, 'gateway.yaml'), gatewayManifest(env.name, token))
      await runCommand(
        'kubectl', ['apply', '-f', join(tmpDir, 'gateway.yaml')],
        kenv, msg => emit({ type: 'log', message: msg }),
      )
    }

    // 4.5. Deploy monitoring stack (if configured)
    const monitoringConfig = (env as any).monitoringConfig as { stack?: string } | null
    if (monitoringConfig?.stack && monitoringConfig.stack !== 'none') {
      emit({ type: 'step', message: `Deploying monitoring stack (${monitoringConfig.stack})...` })

      // Deploy monitoring namespace
      await runCommand(
        'kubectl', ['create', 'namespace', 'monitoring', '--dry-run=client', '-o', 'yaml', '|', 'kubectl', 'apply', '-f', '-'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      if (monitoringConfig.stack === 'basic' || monitoringConfig.stack === 'full') {
        // Deploy VictoriaMetrics
        emit({ type: 'step', message: 'Deploying VictoriaMetrics (metrics & alerting)...' })
        await runCommand(
          'helm', [
            'upgrade', '--install', 'victoria-metrics-k8s-stack', 'victoriametrics/victoria-metrics-k8s-stack',
            '--namespace', 'victoria-metrics',
            '--create-namespace',
            '--wait',
            '--timeout', '5m',
            '--set', 'serverServiceEnabled=false',
            '--set', 'vmsingle.replicas=1',
          ],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )

        // Deploy ntopng
        emit({ type: 'step', message: 'Deploying ntopng (network traffic analysis)...' })
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/ntopng/service.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
      }

      if (monitoringConfig.stack === 'full') {
        // Deploy ELK stack
        emit({ type: 'step', message: 'Deploying ELK stack (logs & flow analysis)...' })
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/namespace.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/secret.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/elasticsearch-deployment.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/logstash-configmap.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/logstash-deployment.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/kibana-deployment.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )

        // Deploy Elastiflow
        emit({ type: 'step', message: 'Deploying Elastiflow (NetFlow collector)...' })
        await runCommand(
          'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elastiflow/deployment.yaml'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
      }

      // Wait for monitoring pods
      emit({ type: 'step', message: 'Waiting for monitoring pods to become ready...' })
      try {
        await runCommand(
          'kubectl', ['wait', '--for=condition=Ready', '--all', '-n', 'monitoring', '--timeout=300s', 'pods'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
        emit({ type: 'log', message: 'Monitoring stack deployment complete' })
      } catch {
        emit({ type: 'log', message: 'Some monitoring pods not ready yet — will continue on next bootstrap' })
      }
    }

    // 5. Configure Vault + ESO
    await bootstrapK8sVaultAndEso(env, slug, kenv, tmpDir, emit)

    // 6. Resolve ArgoCD URL
    emit({ type: 'step', message: 'Resolving ArgoCD URL...' })
    let argoCdUrl: string | null = null
    const portResult = await runQuiet(
      'kubectl',
      ['get', 'svc', 'argocd-server', '-n', 'argocd',
       '-o', 'jsonpath={.spec.ports[?(@.name=="https")].nodePort}'],
      kenv,
    )
    const nodePort = portResult.out.trim()
    const nodeIpResult = await runQuiet(
      'kubectl',
      ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
      kenv,
    )
    const nodeIp = nodeIpResult.out.trim()
    if (nodePort && nodeIp) {
      argoCdUrl = `https://${nodeIp}:${nodePort}`
      emit({ type: 'log', message: `ArgoCD available at ${argoCdUrl}` })
    }

    // 7. Update environment record
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        argoCdUrl,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: 'Bootstrap complete! Gateway will connect to ORION within ~30 seconds.' })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/** Vault + ESO configuration (shared K8s logic). */
async function bootstrapK8sVaultAndEso(
  env: NonNullable<Awaited<ReturnType<typeof prisma.environment.findUnique>>>,
  slug: string,
  kenv: Record<string, string>,
  tmpDir: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const [vaultAdminSetting, vaultRootSetting, vaultInitSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'vault.adminToken' } }),
    prisma.systemSetting.findUnique({ where: { key: 'vault.rootToken' } }),
    prisma.systemSetting.findUnique({ where: { key: 'vault.initialized' } }),
  ])

  const rawToken = vaultAdminSetting?.value ?? vaultRootSetting?.value
  if (vaultRootSetting?.value && !vaultAdminSetting?.value) {
    emit({ type: 'log', message: 'WARNING: Vault is using a root token. Re-initialize Vault in ORION settings to rotate to a scoped admin token.' })
  }

  if (vaultInitSetting?.value && rawToken) {
    const rootToken = decrypt(String(rawToken))
    const policyName = `orion-cluster-${slug}`
    const roleName   = `orion-cluster-${slug}`

    emit({ type: 'step', message: 'Configuring Vault AppRole for this cluster...' })

    await vaultRequest('sys/mounts/secret', rootToken, 'POST', { type: 'kv', options: { version: '2' } })
    await vaultRequest('sys/auth/approle', rootToken, 'POST', { type: 'approle' })

    const policyRes = await vaultRequest(`sys/policies/acl/${policyName}`, rootToken, 'PUT', {
      policy: [
        // MAJOR fix: env.name was used directly in Vault policy paths without slugification.
        // An env name containing '*' or '/' (e.g. '*') would widen the policy to all secrets.
        // Use the same slug used for policyName/roleName — consistent and safe.
        `path "secret/data/${policyName}/*" { capabilities = ["read", "list"] }`,
        `path "secret/metadata/${policyName}/*" { capabilities = ["read", "list"] }`,
      ].join('\n'),
    })
    if (!policyRes.ok) throw new Error(`Vault policy creation failed (${policyRes.status})`)

    const roleRes = await vaultRequest(`auth/approle/role/${roleName}`, rootToken, 'POST', {
      policies: [policyName],
      token_ttl: '1h',
      token_max_ttl: '24h',
    })
    if (!roleRes.ok) throw new Error(`Vault AppRole role creation failed (${roleRes.status})`)

    const roleIdRes = await vaultRequest(`auth/approle/role/${roleName}/role-id`, rootToken)
    if (!roleIdRes.ok) throw new Error(`Could not fetch Vault role-id (${roleIdRes.status})`)
    const roleId = (roleIdRes.data as { data: { role_id: string } }).data.role_id

    const secretCheck = await runQuiet(
      'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets', '--ignore-not-found'],
      kenv,
    )
    let secretId: string
    if (secretCheck.out.includes('orion-vault-approle')) {
      emit({ type: 'log', message: 'Vault AppRole secret already exists in cluster — skipping secret-id generation' })
      const secretIdFetch = await runQuiet(
        'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets',
                    '-o', 'jsonpath={.data.secretId}'],
        kenv,
      )
      secretId = Buffer.from(secretIdFetch.out.trim(), 'base64').toString('utf8')
    } else {
      const secretIdRes = await vaultRequest(`auth/approle/role/${roleName}/secret-id`, rootToken, 'POST', {})
      if (!secretIdRes.ok) throw new Error(`Could not generate Vault secret-id (${secretIdRes.status})`)
      secretId = (secretIdRes.data as { data: { secret_id: string } }).data.secret_id
    }

    emit({ type: 'log', message: `Vault AppRole '${roleName}' ready` })

    // Install ESO
    emit({ type: 'step', message: 'Installing External Secrets Operator...' })
    await runCommand('helm', ['repo', 'add', 'external-secrets', 'https://charts.external-secrets.io', '--force-update'], kenv, msg => emit({ type: 'log', message: msg }))
    await runCommand('helm', ['repo', 'update', 'external-secrets'], kenv, msg => emit({ type: 'log', message: msg }))
    await runCommand('helm', ['upgrade', '--install', 'external-secrets', 'external-secrets/external-secrets', '--namespace', 'external-secrets', '--create-namespace', '--wait', '--timeout', '5m', '--set', 'installCRDs=true'], kenv, msg => emit({ type: 'log', message: msg }))

    emit({ type: 'log', message: 'Waiting for ESO CRDs...' })
    await runCommand('kubectl', ['wait', '--for=condition=established', '--timeout=120s', 'crd/clustersecretstores.external-secrets.io', 'crd/externalsecrets.external-secrets.io'], kenv, msg => emit({ type: 'log', message: msg }))

    // Apply ClusterSecretStore
    emit({ type: 'step', message: 'Configuring ClusterSecretStore → ORION Vault...' })
    const caCertPem = await readFile(join(VAULT_PROXY_CERTS_DIR, 'ca.crt'), 'utf8').catch(() => null)
    let vaultExtAddr: string
    let tlsConfig: TLSConfig | undefined

    if (caCertPem) {
      vaultExtAddr = `https://${MANAGEMENT_IP}:8200`
      const clientCert = await generateClientCert(env.name, tmpDir)
      if (clientCert) {
        tlsConfig = {
          caBundleB64: Buffer.from(caCertPem).toString('base64'),
          clientCertPem: clientCert.certPem,
          clientKeyPem: clientCert.keyPem,
        }
        emit({ type: 'log', message: 'mTLS enabled' })
      } else {
        tlsConfig = { caBundleB64: Buffer.from(caCertPem).toString('base64'), clientCertPem: '', clientKeyPem: '' }
        emit({ type: 'log', message: 'One-way TLS — client cert skipped' })
      }
    } else {
      vaultExtAddr = `http://${MANAGEMENT_IP}:8200`
    }

    await writeFile(join(tmpDir, 'eso-vault.yaml'), esoVaultManifest(roleId, secretId, vaultExtAddr, tlsConfig))
    await runCommand('kubectl', ['apply', '-f', join(tmpDir, 'eso-vault.yaml')], kenv, msg => emit({ type: 'log', message: msg }))
  } else {
    emit({ type: 'log', message: 'Vault not initialized — skipping ESO setup' })
  }
}

// ── Docker (single host) bootstrap ──────────────────────────────────────────────

/** Bootstrap a single Docker host environment. */
async function bootstrapDockerEnvironment(
  env: NonNullable<Awaited<ReturnType<typeof prisma.environment.findUnique>>>,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const connection = parseHostConnection(env)
  const remotePath  = (env.metadata as Record<string, unknown>)?.remotePath as string ?? '/opt/orion-deploy'
  const slug = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    // 1. Create git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // 2. Sync deployment files to remote host
    emit({ type: 'step', message: `Syncing files to ${connection.host}:${remotePath}...` })
    await syncFilesToHost(connection, tmpDir, remotePath, emit)

    // 3. Deploy docker-compose
    emit({ type: 'step', message: 'Deploying Docker Compose services...' })
    await deployDockerCompose(connection, remotePath, emit)

    // 4. Update environment
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: 'Bootstrap complete! Services deployed via Docker Compose.' })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Docker Swarm bootstrap ─────────────────────────────────────────────────────

/** Bootstrap a Docker Swarm environment. */
async function bootstrapSwarmEnvironment(
  env: NonNullable<Awaited<ReturnType<typeof prisma.environment.findUnique>>>,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const manager = parseHostConnection(env)
  const nodes = (env.metadata as Record<string, unknown>)?.swarmNodes as SwarmNode[] ?? []
  const stackName = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const slug = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    // 1. Create git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // 2. Initialize Swarm
    emit({ type: 'step', message: 'Initializing Docker Swarm...' })
    await setupDockerSwarm(manager, [{ nodeId: 'manager', host: manager.host, role: 'manager' }, ...nodes], emit)

    // 3. Deploy stack
    emit({ type: 'step', message: `Deploying swarm stack "${stackName}"...` })
    await deploySwarmStack(manager, gitInfo.url, stackName, emit)

    // 4. Update environment
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: `Bootstrap complete! Swarm stack "${stackName}" deployed.` })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Main bootstrap (type-dispatched) ────────────────────────────────────────────

// Module-level in-flight set: prevents concurrent bootstraps for the same environment
const bootstrapInFlight = new Set<string>()

export async function bootstrapCluster(
  environmentId: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // MAJOR fix: no concurrency guard — concurrent POST /bootstrap calls for the same
  // environment raced on gateway creation, ArgoCD app setup, and Vault AppRole minting,
  // potentially producing duplicate infra. Use a module-level set as a lightweight lock.
  if (bootstrapInFlight.has(environmentId)) {
    emit({ type: 'error', message: 'Bootstrap already in progress for this environment' })
    throw new Error('Bootstrap already in progress')
  }
  bootstrapInFlight.add(environmentId)

  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) { bootstrapInFlight.delete(environmentId); throw new Error('Environment not found') }
  console.log(`[bootstrap] Starting for environment ${environmentId} (${env.name}, type: ${env.type})`)

  try {
    const envType = env.type ?? 'cluster'

    if (envType === 'docker') {
      return await bootstrapDockerEnvironment(env, emit)
    } else if (envType === 'swarm') {
      return await bootstrapSwarmEnvironment(env, emit)
    } else {
      // Default: K8s/Talos (requires kubeconfig)
      if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')
      return await bootstrapK8sCluster(env, emit)
    }
  } catch (err) {
    console.error(`[bootstrap] Failed: ${err instanceof Error ? err.message : String(err)}`)
    emit({ type: 'error', message: `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}` })
    throw err
  }
}
