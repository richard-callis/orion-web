/**
 * POST /api/webhooks/gitea
 *
 * Unified git webhook endpoint — handles push/PR events from Gitea, GitHub, or GitLab.
 * The path stays /webhooks/gitea for backwards compatibility with existing webhook registrations.
 *
 * Updates GitOpsPR status when a PR is merged or closed outside of ORION
 * (e.g. human approves in the web UI).
 *
 * Signature verification is provider-aware:
 *   Gitea:  X-Gitea-Signature  (HMAC-SHA256 hex)
 *   GitHub: X-Hub-Signature-256 (sha256=<hex>)
 *   GitLab: X-Gitlab-Token     (plain secret)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getGitProvider } from '@/lib/git-provider'
import { isDuplicateWebhookId, extractWebhookId, isStaleWebhook } from '@/lib/webhook-idempotency'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  // Collect all relevant headers for provider-agnostic verification
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })

  // Load provider config to get webhook secret and verify signature
  const provider = await getGitProvider()
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'git.provider.config' } })
  const secret = (setting?.value as { webhookSecret?: string } | null)?.webhookSecret
    ?? process.env.GITEA_WEBHOOK_SECRET
    ?? ''

  if (!provider.verifyWebhookSignature(rawBody, headers, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // SOC2: [CC7] Replay attack prevention — reject stale webhooks
  if (isStaleWebhook(headers)) {
    return NextResponse.json({ error: 'Webhook too old (stale delivery)' }, { status: 410 })
  }

  // SOC2: [CC7] Idempotency — skip duplicate webhook deliveries
  const webhookId = extractWebhookId(headers)
  if (webhookId && isDuplicateWebhookId(webhookId)) {
    return NextResponse.json({ ok: true, skipped: 'duplicate' })
  }

  // Detect event type (provider-agnostic)
  const giteaEvent  = headers['x-gitea-event']
  const githubEvent = headers['x-github-event']
  const gitlabEvent = headers['x-gitlab-event']

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const isPR =
    giteaEvent  === 'pull_request' ||
    githubEvent === 'pull_request' ||
    gitlabEvent === 'Merge Request Hook'

  if (isPR) {
    if (gitlabEvent) {
      await handleGitLabMREvent(payload)
    } else {
      await handlePullRequestEvent(payload)
    }
  }

  return NextResponse.json({ ok: true })
}

/** Handle Gitea + GitHub pull_request events (same shape for our purposes) */
async function handlePullRequestEvent(payload: Record<string, unknown>) {
  const action = payload.action as string
  if (action !== 'closed') return

  const pr = payload.pull_request as Record<string, unknown> | undefined
  if (!pr) return

  const prNumber = pr.number as number
  const repoFullName = (payload.repository as Record<string, unknown>)?.full_name as string
  if (!repoFullName || !prNumber) return

  const [owner, repoName] = repoFullName.split('/')
  const env = await prisma.environment.findFirst({
    where: { gitOwner: owner, gitRepo: repoName },
  })
  if (!env) return

  const record = await prisma.gitOpsPR.findUnique({
    where: { environmentId_prNumber: { environmentId: env.id, prNumber } },
  })
  if (!record) return

  const merged = pr.merged as boolean
  await prisma.gitOpsPR.update({
    where: { id: record.id },
    data: {
      status:   merged ? 'merged' : 'closed',
      mergedAt: merged ? new Date() : null,
    },
  })
}

/** Handle GitLab Merge Request Hook events */
async function handleGitLabMREvent(payload: Record<string, unknown>) {
  const attrs = payload.object_attributes as Record<string, unknown> | undefined
  if (!attrs) return

  const action = attrs.action as string
  if (action !== 'close' && action !== 'merge') return

  const prNumber = attrs.iid as number
  const project  = payload.project as Record<string, unknown> | undefined
  const pathWithNamespace = project?.path_with_namespace as string | undefined
  if (!pathWithNamespace || !prNumber) return

  const [owner, ...repoParts] = pathWithNamespace.split('/')
  const repoName = repoParts.join('/')

  const env = await prisma.environment.findFirst({
    where: { gitOwner: owner, gitRepo: repoName },
  })
  if (!env) return

  const record = await prisma.gitOpsPR.findUnique({
    where: { environmentId_prNumber: { environmentId: env.id, prNumber } },
  })
  if (!record) return

  const merged = action === 'merge'
  await prisma.gitOpsPR.update({
    where: { id: record.id },
    data: {
      status:   merged ? 'merged' : 'closed',
      mergedAt: merged ? new Date() : null,
    },
  })
}
