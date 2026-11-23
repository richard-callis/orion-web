/**
 * Localhost / Docker Environment Bootstrap
 *
 * Run by the "Deploy" button of a localhost or docker environment:
 *   1. Create a Gitea org (if needed) and the environment repo
 *   2. Commit the CI/CD scaffold (README + deploy.yml) and register the webhook
 *   3. Update the environment DB record with repo info
 *
 * ORION holds no Docker socket (root on the host). A localhost environment's
 * gateway is ORION's own compose `gateway` service, and its Actions runner is
 * registered by the installer. A docker environment's gateway is started by the
 * owner with the Deploy Gateway command (generate-join), and a runner is
 * registered from Gitea's runner settings.
 */

import { randomBytes } from 'crypto'
import { prisma } from './db'
import { getGitProvider, getGitProviderConfig } from './git-provider'
import { GiteaGitProvider } from './git-provider/gitea-provider'

export type LocalBootstrapEvent =
  | { type: 'step';  message: string }
  | { type: 'log';   message: string }
  | { type: 'error'; message: string }
  | { type: 'done';  message: string }

const ORION_CALLBACK_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  'http://localhost:3000'
).replace(/\/$/, '')

if (!process.env.ORION_CALLBACK_URL && !process.env.MANAGEMENT_IP) {
  console.warn('[orion] WARNING: Neither ORION_CALLBACK_URL nor MANAGEMENT_IP is set. Gateway/webhook URLs will use localhost — this will break in container environments.')
}

// ── CI/CD scaffold ────────────────────────────────────────────────────────────

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
      - name: Setup
        run: |
          which git || (apt-get update -qq && apt-get install -y -qq git curl)

      - name: Checkout
        run: |
          if [ -d ".git" ]; then
            git fetch origin main
            git reset --hard origin/main
          else
            GITEA_HOST=$(echo "$\{{ gitea.server_url }}" | sed 's|https://||;s|http://||')
            git clone http://x-gitea-token:$\{{ gitea.token }}@\${GITEA_HOST}/$\{{ gitea.repository }} .
          fi

      - name: Deploy changed services
        run: |
          CHANGED=$(git diff --name-only HEAD~1 HEAD | grep '^services/' | cut -d/ -f1-2 | sort -u || true)
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
          curl -sf -X POST "${orionUrl}/api/webhooks/gitea" \\
            -H "Content-Type: application/json" \\
            -d '{"action":"deploy_complete","status":"$\{{ job.status }}"}' || true
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

  // ── Step 1: Gitea repo ───────────────────────────────────────────────────────
  emit({ type: 'step', message: 'Setting up Gitea repository…' })
  const provider = await getGitProvider()
  const providerHealthy = await provider.isHealthy()

  let gitOwner: string = ''
  let gitRepo:  string = ''

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

    // Use the webhook secret from git provider config so ORION can verify signatures.
    // Read through getGitProviderConfig() (decrypts properly) rather than the raw
    // SystemSetting row — reading it raw only ever worked by accident, on installs
    // where the row happened to still be unencrypted plaintext; it silently
    // regenerates a fresh random secret (breaking webhook verification with no
    // error anywhere) the moment that row is properly encrypted.
    const gitProviderConfig = await getGitProviderConfig()
    const webhookSecret = gitProviderConfig?.webhookSecret
      ?? randomBytes(32).toString('hex')
    const repo = await provider.ensureRepo({
      owner: gitOwner,
      name: gitRepo,
      description: `ORION-managed Docker environment: ${env.name}`,
      private: false,
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

    emit({ type: 'log', message: env.type === 'localhost'
      ? "Actions runner: this host's runner (orion-runner-localhost) is registered by ORION's installer."
      : 'Actions runner: register one for this repo in Gitea (Site Administration → Actions → Runners).' })
  }

  // ── Step 2: Update environment record ────────────────────────────────────────
  await prisma.environment.update({
    where: { id: environmentId },
    data: {
      ...(gitOwner ? { gitOwner } : {}),
      ...(gitRepo  ? { gitRepo  } : {}),
    },
  })

  emit({ type: 'done', message: env.type === 'localhost'
    ? (env.status === 'connected'
      ? "Repository ready. This host's gateway is ORION's own gateway service, already running."
      : "Repository ready. No gateway is connected. Check ORION's gateway service: it serves the first localhost environment only. For another gateway on this host, add it as a Docker environment (a private gateway URL needs ALLOW_PRIVATE_GATEWAY_URLS=true).")
    : 'Repository ready. Start the gateway with the command below; it connects within ~30 seconds.' })
}
