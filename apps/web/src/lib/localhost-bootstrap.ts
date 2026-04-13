/**
 * Localhost / Docker Environment Bootstrap
 *
 * Full setup when the "Deploy" button is pressed on a localhost or docker environment:
 *   1. Deploy the ORION gateway container via Docker socket
 *   2. Create a Gitea org (if needed) and environment repo
 *   3. Commit the CI/CD scaffold (README + deploy.yml)
 *   4. Register a Gitea Actions self-hosted runner (act_runner container)
 *   5. Update the environment DB record with repo info
 */

import http from 'http'
import { randomBytes } from 'crypto'
import { prisma } from './db'
import { getGitProvider } from './git-provider'
import { GiteaGitProvider } from './git-provider/gitea-provider'

export type LocalBootstrapEvent =
  | { type: 'step';  message: string }
  | { type: 'log';   message: string }
  | { type: 'error'; message: string }
  | { type: 'done';  message: string }

const SOCKET           = '/var/run/docker.sock'
const GATEWAY_IMAGE    = `ghcr.io/${process.env.GITHUB_ORG ?? 'richard-callis'}/orion-gateway:latest`
const RUNNER_IMAGE     = 'gitea/act_runner:latest'
const ORION_CALLBACK_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  process.env.NEXTAUTH_URL ??
  'http://localhost:3000'
).replace(/\/$/, '')

// ── Docker socket helpers ─────────────────────────────────────────────────────

function dockerRequest(opts: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined
    const req = http.request(
      {
        socketPath: SOCKET,
        method: opts.method,
        path: opts.path,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function dockerPull(image: string, onLog: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const [repoTag] = image.split(':')
    const tag = image.includes(':') ? image.split(':')[1] : 'latest'
    const path = `/images/create?fromImage=${encodeURIComponent(repoTag)}&tag=${encodeURIComponent(tag)}`
    const req = http.request({ socketPath: SOCKET, method: 'POST', path }, (res) => {
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line) as { status?: string; progress?: string; error?: string }
            if (evt.error) { reject(new Error(evt.error)); return }
            const msg = evt.progress ? `${evt.status} ${evt.progress}` : evt.status
            if (msg) onLog(msg)
          } catch { /* ignore */ }
        }
      })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function removeContainer(name: string): Promise<void> {
  await dockerRequest({ method: 'DELETE', path: `/containers/${encodeURIComponent(name)}?force=true` })
}

async function createAndStartContainer(name: string, body: unknown): Promise<string> {
  const createRes = await dockerRequest({
    method: 'POST',
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body,
  })
  if (createRes.status !== 201) {
    throw new Error(`Container create failed (${createRes.status}): ${createRes.body}`)
  }
  const { Id } = JSON.parse(createRes.body) as { Id: string }
  const startRes = await dockerRequest({ method: 'POST', path: `/containers/${Id}/start` })
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Container start failed (${startRes.status}): ${createRes.body}`)
  }
  return Id
}

// ── Gitea runner registration token ──────────────────────────────────────────

async function getRunnerRegistrationToken(provider: GiteaGitProvider): Promise<string> {
  // Access the private Gitea API via the fetch helper using the internal method pattern.
  // We need to call POST /api/v1/admin/runners/registration-token.
  // Since we can't call the private fetch directly, we use the provider's base URL via env.
  const giteaUrl = (process.env.GITEA_URL ?? 'http://gitea:3000').replace(/\/$/, '')
  const token    = process.env.GITEA_ADMIN_TOKEN ?? ''
  const res = await fetch(`${giteaUrl}/api/v1/admin/runners/registration-token`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to get runner registration token: ${res.status} ${detail}`)
  }
  const data = await res.json() as { token: string }
  return data.token
}

// ── Scaffold files ────────────────────────────────────────────────────────────

function buildDockerScaffold(envName: string, orionUrl: string): { path: string; content: string }[] {
  const readme = `# ${envName}

This repo is managed by ORION. Propose changes via ORION's AI interface — do not edit directly.

## How it works

When a change is merged to \`main\`, the Gitea Actions runner on this host automatically
runs \`docker compose pull && docker compose up -d\` in the changed service directory.

## Directory Layout

\`\`\`
services/
└── <service-name>/
    └── docker-compose.yml
\`\`\`
`

  const deployWorkflow = `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Deploy changed services
        run: |
          CHANGED=$(git diff --name-only HEAD~1 HEAD | grep '^services/' | cut -d/ -f1-2 | sort -u)
          for SERVICE_DIR in $CHANGED; do
            if [ -f "$SERVICE_DIR/docker-compose.yml" ]; then
              echo "Deploying $SERVICE_DIR..."
              cd "$SERVICE_DIR"
              docker compose pull
              docker compose up -d --remove-orphans
              cd -
            fi
          done

      - name: Report status to ORION
        if: always()
        run: |
          curl -s -X POST "${orionUrl}/api/webhooks/gitea" \\
            -H "Content-Type: application/json" \\
            -d '{"action":"deploy_complete","status":"$\{{ job.status }}"}'
`

  return [
    { path: 'README.md',                         content: readme },
    { path: '.gitea/workflows/deploy.yml',        content: deployWorkflow },
  ]
}

// ── Main bootstrap ────────────────────────────────────────────────────────────

export async function bootstrapLocalEnvironment(
  environmentId: string,
  emit: (event: LocalBootstrapEvent) => void,
): Promise<void> {
  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) throw new Error('Environment not found')
  if (env.type !== 'localhost' && env.type !== 'docker') {
    throw new Error(`bootstrapLocalEnvironment only supports localhost/docker, got: ${env.type}`)
  }

  const slug          = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const gatewayName   = `orion-gateway-${slug}`
  const runnerName    = `orion-runner-${slug}`
  const composeNet    = 'deploy_default'

  // ── Step 1: Deploy gateway container ────────────────────────────────────────
  emit({ type: 'step', message: 'Generating join token…' })
  await prisma.environmentJoinToken.deleteMany({ where: { environmentId, usedAt: null } })
  const joinToken = 'orion_' + randomBytes(24).toString('hex')
  await prisma.environmentJoinToken.create({
    data: { token: joinToken, environmentId, expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  })

  emit({ type: 'step', message: `Pulling gateway image…` })
  await dockerPull(GATEWAY_IMAGE, msg => emit({ type: 'log', message: msg }))

  emit({ type: 'step', message: 'Deploying gateway container…' })
  await removeContainer(gatewayName)
  const gatewayUrl = env.gatewayUrl ?? `http://${process.env.MANAGEMENT_IP ?? 'localhost'}:3001`
  await createAndStartContainer(gatewayName, {
    Image: GATEWAY_IMAGE,
    Env: [
      `JOIN_TOKEN=${joinToken}`,
      `GATEWAY_TYPE=${env.type}`,
      `ORION_URL=${ORION_CALLBACK_URL}`,
      `GATEWAY_URL=${gatewayUrl}`,
    ],
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: composeNet,
    },
  })
  emit({ type: 'log', message: 'Gateway container started — will connect within ~30s.' })

  // ── Step 2: Gitea repo ───────────────────────────────────────────────────────
  emit({ type: 'step', message: 'Setting up Gitea repository…' })
  const provider = await getGitProvider()
  const providerHealthy = await provider.isHealthy()

  let gitOwner: string | null = null
  let gitRepo:  string | null = null

  if (!providerHealthy) {
    emit({ type: 'log', message: 'Git provider not reachable — skipping repo setup. Re-deploy after Gitea is running.' })
  } else {
    gitOwner = env.gitOwner ?? 'orion'
    gitRepo  = env.gitRepo  ?? slug

    // Ensure the org exists (Gitea-specific — no-op for GitHub/GitLab)
    if (provider instanceof GiteaGitProvider) {
      try {
        await provider.ensureOrg(gitOwner)
        emit({ type: 'log', message: `Org "${gitOwner}" ready.` })
      } catch (e) {
        emit({ type: 'log', message: `Org creation skipped: ${e instanceof Error ? e.message : e}` })
      }
    }

    const webhookSecret = randomBytes(32).toString('hex')
    const repo = await provider.ensureRepo({
      owner: gitOwner,
      name: gitRepo,
      description: `ORION-managed Docker environment: ${env.name}`,
      private: true,
      isOrg: true,
    })
    emit({ type: 'log', message: `Repo ready: ${repo.htmlUrl}` })

    // Commit scaffold files
    const files = buildDockerScaffold(env.name, ORION_CALLBACK_URL)
    try {
      await provider.commitFiles({
        owner: gitOwner,
        repo: gitRepo,
        branch: 'main',
        files,
        message: 'chore: initial scaffold by ORION',
      })
      emit({ type: 'log', message: 'Scaffold committed (README + deploy.yml).' })
    } catch {
      emit({ type: 'log', message: 'Scaffold already exists — skipped.' })
    }

    // Register webhook
    await provider.ensureWebhook(
      gitOwner,
      gitRepo,
      `${ORION_CALLBACK_URL}/api/webhooks/gitea`,
      webhookSecret,
    )
    emit({ type: 'log', message: 'Webhook registered.' })

    // ── Step 3: Gitea Actions runner ──────────────────────────────────────────
    emit({ type: 'step', message: 'Registering Gitea Actions runner…' })
    try {
      const regToken = await getRunnerRegistrationToken(provider as GiteaGitProvider)
      const giteaInternalUrl = process.env.GITEA_URL ?? 'http://gitea:3000'

      emit({ type: 'log', message: `Pulling runner image…` })
      await dockerPull(RUNNER_IMAGE, msg => emit({ type: 'log', message: msg }))

      await removeContainer(runnerName)
      await createAndStartContainer(runnerName, {
        Image: RUNNER_IMAGE,
        Env: [
          `GITEA_INSTANCE_URL=${giteaInternalUrl}`,
          `GITEA_RUNNER_REGISTRATION_TOKEN=${regToken}`,
          `GITEA_RUNNER_NAME=${runnerName}`,
          `GITEA_RUNNER_LABELS=self-hosted,docker,${slug}`,
        ],
        HostConfig: {
          Binds: [
            '/var/run/docker.sock:/var/run/docker.sock',
            `orion-runner-${slug}:/data`,
          ],
          RestartPolicy: { Name: 'unless-stopped' },
          NetworkMode: composeNet,
        },
      })
      emit({ type: 'log', message: `Runner "${runnerName}" started — registering with Gitea…` })
    } catch (e) {
      // Runner setup is best-effort — Gitea Actions may not be enabled
      emit({ type: 'log', message: `Runner setup skipped: ${e instanceof Error ? e.message : e}` })
    }
  }

  // ── Step 4: Update environment record ────────────────────────────────────────
  await prisma.environment.update({
    where: { id: environmentId },
    data: {
      ...(gitOwner ? { gitOwner } : {}),
      ...(gitRepo  ? { gitRepo  } : {}),
    },
  })

  emit({ type: 'done', message: 'Bootstrap complete! Gateway will connect within ~30 seconds.' })
}
