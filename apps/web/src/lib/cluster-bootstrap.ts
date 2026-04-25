/**
 * Cluster Bootstrap
 *
 * Deploys ArgoCD + ORION Gateway into a newly registered K8s environment.
 * Called from POST /api/environments/[id]/bootstrap.
 *
 * Steps:
 *   1.  Write kubeconfig to a temp file
 *   2.  Verify cluster connectivity
 *   3.  Ensure Gitea repo exists for this environment
 *   4.  Add ArgoCD Helm repo
 *   5.  Install ArgoCD via Helm
 *   6.  Configure ArgoCD (AppProject + root Application → Gitea repo)
 *   7.  Deploy Gateway via kubectl apply
 *   8.  Create Vault AppRole + policy scoped to this environment
 *   9.  Install External Secrets Operator via Helm
 *   10. Apply ClusterSecretStore pointing to ORION Vault
 *   11. Resolve ArgoCD NodePort URL
 *   12. Update environment record + clean up temp files
 */

import { spawn } from 'child_process'
import { writeFile, readFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from './db'
import { decrypt } from './encryption'
import { bootstrapEnvironmentRepo } from './gitops'
import { getGitProvider } from './git-provider'

const ORION_URL       = process.env.NEXTAUTH_URL  ?? 'http://localhost:3000'
const VAULT_ADDR      = process.env.VAULT_ADDR    ?? 'http://vault:8200'
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

// ── ArgoCD manifests ──────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
}

function argoCdAppProject(envName: string, repoUrl: string): string {
  const slug = toSlug(envName)
  return `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${slug}
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
  const slug = toSlug(envName)
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${slug}
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: ${slug}
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
apiVersion: external-secrets.io/v1beta1
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
  const res = await fetch(`${VAULT_ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
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

  console.log(`[bootstrap] Starting for environment ${environmentId} (${env.name})`)
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
    console.log(`[bootstrap] Git provider healthy: ${providerHealthy}`)
    let resolvedGitOwner = gitOwner
    if (!providerHealthy) {
      emit({ type: 'log', message: 'Git provider not reachable — skipping repo creation (will retry on next bootstrap)' })
    } else {
      const createdRepo = await bootstrapEnvironmentRepo({
        owner: gitOwner,
        repoName: gitRepo,
        description: `ORION-managed K8s cluster: ${env.name}`,
        webhookUrl: `${orionUrl}/api/webhooks/gitea`,
        webhookSecret: randomBytes(32).toString('hex'),
      })
      // Use the owner the provider resolved (authenticated user, not the default 'orion')
      resolvedGitOwner = createdRepo.fullName.split('/')[0]
      emit({ type: 'log', message: `Git repo ready: ${createdRepo.htmlUrl}` })
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
        '--set', 'server.service.type=NodePort',
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

    // 7. Deploy Gateway (skip if already running — re-applying would rotate the token)
    emit({ type: 'step', message: 'Deploying ORION Gateway...' })
    const gwCheck = await runQuiet(
      'kubectl', ['get', 'deployment', 'orion-gateway', '-n', 'orion-management', '--ignore-not-found'],
      kenv,
    )
    if (gwCheck.out.includes('orion-gateway')) {
      emit({ type: 'log', message: 'Gateway already deployed — skipping (use re-bootstrap to force update)' })
    } else {
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
    }

    // 8. Configure Vault AppRole + install ESO (if Vault is initialized in ORION)
    const [vaultAdminSetting, vaultRootSetting, vaultInitSetting] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'vault.adminToken' } }),
      prisma.systemSetting.findUnique({ where: { key: 'vault.rootToken' } }),
      prisma.systemSetting.findUnique({ where: { key: 'vault.initialized' } }),
    ])

    // Prefer the scoped admin token; fall back to root token for instances
    // initialized before the admin-token migration (emit a warning).
    const rawToken = vaultAdminSetting?.value ?? vaultRootSetting?.value
    if (vaultRootSetting?.value && !vaultAdminSetting?.value) {
      emit({ type: 'log', message: 'WARNING: Vault is using a root token. Re-initialize Vault in ORION settings to rotate to a scoped admin token.' })
    }

    if (vaultInitSetting?.value && rawToken) {
      const rootToken  = decrypt(String(rawToken))
      const policyName = `orion-cluster-${toSlug(env.name)}`
      const roleName   = `orion-cluster-${toSlug(env.name)}`

      emit({ type: 'step', message: 'Configuring Vault AppRole for this cluster...' })

      // Enable KV v2 at path "secret" (400 = already exists, which is fine)
      await vaultRequest('sys/mounts/secret', rootToken, 'POST', { type: 'kv', options: { version: '2' } })

      // Enable AppRole auth method (400 = already exists, which is fine)
      await vaultRequest('sys/auth/approle', rootToken, 'POST', { type: 'approle' })

      // Create policy scoped to this env's secret paths
      const policyRes = await vaultRequest(`sys/policies/acl/${policyName}`, rootToken, 'PUT', {
        policy: [
          `path "secret/data/${env.name}/*" { capabilities = ["read", "list"] }`,
          `path "secret/metadata/${env.name}/*" { capabilities = ["read", "list"] }`,
        ].join('\n'),
      })
      if (!policyRes.ok) throw new Error(`Vault policy creation failed (${policyRes.status})`)

      // Create AppRole role bound to the policy
      const roleRes = await vaultRequest(`auth/approle/role/${roleName}`, rootToken, 'POST', {
        policies: [policyName],
        token_ttl: '1h',
        token_max_ttl: '24h',
      })
      if (!roleRes.ok) throw new Error(`Vault AppRole role creation failed (${roleRes.status})`)

      // Fetch role-id
      const roleIdRes = await vaultRequest(`auth/approle/role/${roleName}/role-id`, rootToken)
      if (!roleIdRes.ok) throw new Error(`Could not fetch Vault role-id (${roleIdRes.status})`)
      const roleId = (roleIdRes.data as { data: { role_id: string } }).data.role_id

      // Check if ClusterSecretStore secret already exists (idempotent re-run)
      const secretCheck = await runQuiet(
        'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets', '--ignore-not-found'],
        kenv,
      )
      let secretId: string
      if (secretCheck.out.includes('orion-vault-approle')) {
        emit({ type: 'log', message: 'Vault AppRole secret already exists in cluster — skipping secret-id generation' })
        // Fetch secretId from the existing K8s secret so we can rebuild the manifest if needed
        const secretIdFetch = await runQuiet(
          'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets',
                      '-o', 'jsonpath={.data.secretId}'],
          kenv,
        )
        secretId = Buffer.from(secretIdFetch.out.trim(), 'base64').toString('utf8')
      } else {
        // Generate a new secret-id (no TTL — persists until explicitly revoked)
        const secretIdRes = await vaultRequest(`auth/approle/role/${roleName}/secret-id`, rootToken, 'POST', {})
        if (!secretIdRes.ok) throw new Error(`Could not generate Vault secret-id (${secretIdRes.status})`)
        secretId = (secretIdRes.data as { data: { secret_id: string } }).data.secret_id
      }

      emit({ type: 'log', message: `Vault AppRole '${roleName}' ready` })

      // 9. Install External Secrets Operator via Helm
      emit({ type: 'step', message: 'Installing External Secrets Operator...' })
      await runCommand(
        'helm',
        ['repo', 'add', 'external-secrets', 'https://charts.external-secrets.io', '--force-update'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'helm',
        ['repo', 'update', 'external-secrets'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'helm',
        [
          'upgrade', '--install', 'external-secrets', 'external-secrets/external-secrets',
          '--namespace', 'external-secrets',
          '--create-namespace',
          '--wait',
          '--timeout', '5m',
          '--set', 'installCRDs=true',
        ],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      // Wait for ESO CRDs to be established before applying ClusterSecretStore
      emit({ type: 'log', message: 'Waiting for ESO CRDs to be established...' })
      await runCommand(
        'kubectl',
        [
          'wait', '--for=condition=established', '--timeout=120s',
          'crd/clustersecretstores.external-secrets.io',
          'crd/externalsecrets.external-secrets.io',
        ],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      // 10. Apply ClusterSecretStore + AppRole credentials Secret
      //     If vault-proxy certs exist: use HTTPS + mTLS. Otherwise fall back to HTTP.
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
          emit({ type: 'log', message: 'mTLS enabled: cluster client cert generated and signed by ORION Vault CA' })
        } else {
          // CA cert exists but CA key not readable — one-way TLS only
          tlsConfig = {
            caBundleB64: Buffer.from(caCertPem).toString('base64'),
            clientCertPem: '',
            clientKeyPem: '',
          }
          emit({ type: 'log', message: 'One-way TLS: CA cert found but CA key not readable — client cert skipped' })
        }
      } else {
        vaultExtAddr = `http://${MANAGEMENT_IP}:8200`
        emit({ type: 'log', message: 'No vault-proxy certs found — using plain HTTP (run generate-vault-certs.sh to enable mTLS)' })
      }

      const esoYaml = join(tmpDir, 'eso-vault.yaml')
      await writeFile(esoYaml, esoVaultManifest(roleId, secretId, vaultExtAddr, tlsConfig))
      await runCommand(
        'kubectl', ['apply', '-f', esoYaml],
        kenv, msg => emit({ type: 'log', message: msg }),
      )
      emit({ type: 'log', message: `ClusterSecretStore 'orion-vault' → ${vaultExtAddr}` })
    } else {
      emit({ type: 'log', message: 'Vault not initialized in ORION — skipping ESO setup (run Vault setup in ORION first, then re-bootstrap)' })
    }

    // 11. Resolve ArgoCD NodePort + node IP → accessible URL
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
    } else {
      emit({ type: 'log', message: 'Could not determine ArgoCD URL — set it manually in environment settings' })
    }

    // 12. Update environment record with git repo info + ArgoCD URL
    await prisma.environment.update({
      where: { id: environmentId },
      data: {
        gitOwner: resolvedGitOwner,
        gitRepo:  gitRepo,
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
