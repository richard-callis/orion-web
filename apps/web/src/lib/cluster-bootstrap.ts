/**
 * Cluster Bootstrap
 *
 * Deploys ArgoCD + ORION Gateway into a newly registered K8s environment.
 * Called from POST /api/environments/[id]/bootstrap.
 *
 * Steps:
 *   1. Write kubeconfig to a temp file
 *   2. Ensure Gitea repo exists for this environment
 *   3. Deploy ArgoCD via Helm
 *   4. Configure ArgoCD (AppProject + root Application → Gitea repo)
 *   5. Deploy Gateway via kubectl apply (uses manifest from join token)
 *   6. Clean up temp files
 */

import { spawn } from 'child_process'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from './db'
import { bootstrapEnvironmentRepo } from './gitops'
import { getGitProvider } from './git-provider'

const ORION_URL = process.env.NEXTAUTH_URL ?? 'http://localhost:3000'

export type BootstrapEvent =
  | { type: 'step'; message: string }
  | { type: 'log'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }

// ── Shell helpers ─────────────────────────────────────────────────────────────

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

// ── ArgoCD manifests ──────────────────────────────────────────────────────────

function argoCdAppProject(envName: string, repoUrl: string): string {
  return `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${envName}
  namespace: argocd
spec:
  description: ORION-managed environment ${envName}
  sourceRepos:
    - '${repoUrl}'
  destinations:
    - namespace: '*'
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: '*'
      kind: '*'
`
}

function argoCdApplication(envName: string, repoUrl: string): string {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${envName}
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: ${envName}
  source:
    repoURL: ${repoUrl}
    targetRevision: main
    path: .
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`
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

// ── Main bootstrap ────────────────────────────────────────────────────────────

export async function bootstrapCluster(
  environmentId: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) throw new Error('Environment not found')
  if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')

  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })
  const kubeconfigPath = join(tmpDir, 'kubeconfig')

  try {
    // 1. Write kubeconfig
    emit({ type: 'step', message: 'Writing kubeconfig...' })
    const kubeconfigYaml = Buffer.from(env.kubeconfig, 'base64').toString('utf8')
    await writeFile(kubeconfigPath, kubeconfigYaml, { mode: 0o600 })
    const kenv = { KUBECONFIG: kubeconfigPath }

    // 2. Verify cluster connectivity
    emit({ type: 'step', message: 'Verifying cluster connectivity...' })
    await runCommand('kubectl', ['cluster-info'], kenv, msg => emit({ type: 'log', message: msg }))

    // 3. Ensure git repo
    emit({ type: 'step', message: 'Creating git repository...' })
    const gitOwner = env.gitOwner ?? 'orion'
    const gitRepo  = env.gitRepo  ?? env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const orionUrl = ORION_URL.replace(/\/$/, '')

    const provider = await getGitProvider()
    const providerHealthy = await provider.isHealthy()
    if (!providerHealthy) {
      emit({ type: 'log', message: 'Git provider not reachable — skipping repo creation (will retry on next bootstrap)' })
    } else {
      await bootstrapEnvironmentRepo({
        owner: gitOwner,
        repoName: gitRepo,
        description: `ORION-managed K8s cluster: ${env.name}`,
        webhookUrl: `${orionUrl}/api/webhooks/gitea`,
        webhookSecret: randomBytes(32).toString('hex'),
      })
      emit({ type: 'log', message: `Git repo created: ${provider.getPRUrl(gitOwner, gitRepo, 0).replace(/\/pull\/0$/, '')}` })
    }

    // 4. Add Argo Helm repo
    emit({ type: 'step', message: 'Adding ArgoCD Helm repo...' })
    await runCommand(
      'helm',
      ['repo', 'add', 'argo', 'https://argoproj.github.io/argo-helm', '--force-update'],
      kenv,
      msg => emit({ type: 'log', message: msg }),
    )
    await runCommand('helm', ['repo', 'update'], kenv, msg => emit({ type: 'log', message: msg }))

    // 5. Install ArgoCD
    emit({ type: 'step', message: 'Installing ArgoCD (this may take 2-3 minutes)...' })
    await runCommand(
      'helm',
      [
        'upgrade', '--install', 'argocd', 'argo/argo-cd',
        '--namespace', 'argocd',
        '--create-namespace',
        '--wait',
        '--timeout', '5m',
        '--set', 'server.service.type=ClusterIP',
      ],
      kenv,
      msg => emit({ type: 'log', message: msg }),
    )

    // 6. Configure ArgoCD (AppProject + Application)
    if (providerHealthy && env.gitRepo) {
      emit({ type: 'step', message: 'Configuring ArgoCD...' })
      // Use the git provider's repo URL (clone URL without .git suffix stripped for display)
      const gitRepoCloneUrl = provider.getPRUrl(gitOwner, gitRepo, 0)
        .replace(/\/pull\/0$/, '')
        .replace(/\/-\/merge_requests\/0$/, '') + '.git'

      const appProjectYaml = join(tmpDir, 'appproject.yaml')
      const appYaml = join(tmpDir, 'application.yaml')
      await writeFile(appProjectYaml, argoCdAppProject(env.name, gitRepoCloneUrl))
      await writeFile(appYaml, argoCdApplication(env.name, gitRepoCloneUrl))

      await runCommand(
        'kubectl', ['apply', '-f', appProjectYaml],
        kenv, msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'kubectl', ['apply', '-f', appYaml],
        kenv, msg => emit({ type: 'log', message: msg }),
      )
      emit({ type: 'log', message: `ArgoCD watching: ${gitRepoCloneUrl}` })
    }

    // 7. Deploy Gateway
    emit({ type: 'step', message: 'Deploying ORION Gateway...' })

    // Generate a join token for this environment
    const token = `orion_${randomBytes(24).toString('hex')}`
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
    await prisma.environmentJoinToken.create({
      data: { token, environmentId, expiresAt },
    })

    const gatewayYaml = join(tmpDir, 'gateway.yaml')
    await writeFile(gatewayYaml, gatewayManifest(env.name, token))
    await runCommand(
      'kubectl', ['apply', '-f', gatewayYaml],
      kenv, msg => emit({ type: 'log', message: msg }),
    )

    // 8. Update environment record with git repo info + ArgoCD URL
    const argoCdUrl = `https://argocd.${env.name}.internal` // placeholder; real URL depends on ingress
    await prisma.environment.update({
      where: { id: environmentId },
      data: {
        gitOwner,
        gitRepo,
        argoCdUrl,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: 'Bootstrap complete! Gateway will connect to ORION within ~30 seconds.' })
  } finally {
    // Clean up temp files (always, even on failure)
    await rm(tmpDir, { recursive: true, force: true })
  }
}
