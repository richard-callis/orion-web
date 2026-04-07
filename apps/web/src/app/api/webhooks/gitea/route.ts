/**
 * POST /api/webhooks/gitea
 *
 * Receives push and pull_request events from Gitea.
 * Updates GitOpsPR status when a PR is merged or closed outside of ORION
 * (e.g. human approves in the Gitea UI).
 *
 * Gitea signs requests with HMAC-SHA256 using GITEA_WEBHOOK_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'

const WEBHOOK_SECRET = process.env.GITEA_WEBHOOK_SECRET ?? ''

function verifySignature(body: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true // dev mode — skip verification
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-gitea-signature') ?? ''

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = req.headers.get('x-gitea-event')
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (event === 'pull_request') {
    await handlePullRequestEvent(payload)
  }
  // push events could trigger ArgoCD status checks in future

  return NextResponse.json({ ok: true })
}

async function handlePullRequestEvent(payload: Record<string, unknown>) {
  const action = payload.action as string
  const pr = payload.pull_request as Record<string, unknown> | undefined
  if (!pr) return

  const prNumber = pr.number as number
  const repoFullName = (payload.repository as Record<string, unknown>)?.full_name as string
  if (!repoFullName || !prNumber) return

  // Find matching environment by Gitea repo
  const [owner, repoName] = repoFullName.split('/')
  const env = await prisma.environment.findFirst({
    where: { giteaOwner: owner, giteaRepo: repoName },
  })
  if (!env) return

  const record = await prisma.gitOpsPR.findUnique({
    where: { environmentId_prNumber: { environmentId: env.id, prNumber } },
  })
  if (!record) return

  if (action === 'closed') {
    const merged = pr.merged as boolean
    await prisma.gitOpsPR.update({
      where: { id: record.id },
      data: {
        status:   merged ? 'merged' : 'closed',
        mergedAt: merged ? new Date() : null,
      },
    })
  }
}
