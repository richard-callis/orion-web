export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireWriteAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { verifyGithubToken, encryptAndStoreGithubToken, clearGithubToken } from '@/lib/github'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET() {
  let user
  try { user = await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { githubTokenEncrypted: true, githubUsername: true, githubAllowedRepos: true },
  })
  return NextResponse.json({
    connected: !!dbUser?.githubTokenEncrypted,
    githubUsername: dbUser?.githubUsername ?? null,
    allowedRepos: dbUser?.githubAllowedRepos ?? [],
  })
}

const ConnectSchema = z.object({ token: z.string().min(1).max(256) })

export async function POST(req: NextRequest) {
  let user
  try { user = await requireWriteAccess() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = ConnectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const { token } = parsed.data
  const verified = await verifyGithubToken(token)
  if (!verified) {
    return NextResponse.json({ error: 'Invalid GitHub token' }, { status: 401 })
  }
  await encryptAndStoreGithubToken(user.id, token, verified.login)
  logAudit({
    userId: user.id,
    action: 'github_connect',
    target: `user:${user.id}`,
    detail: { githubUsername: verified.login },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})
  return NextResponse.json({ connected: true, githubUsername: verified.login })
}

const AllowlistSchema = z.object({
  allowedRepos: z.array(z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)).max(100),
})

export async function PUT(req: NextRequest) {
  let user
  try { user = await requireWriteAccess() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = AllowlistSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const normalized = parsed.data.allowedRepos.map(r => r.toLowerCase())
  await prisma.user.update({
    where: { id: user.id },
    data: { githubAllowedRepos: normalized },
  })
  logAudit({
    userId: user.id,
    action: 'github_allowlist_update',
    target: `user:${user.id}`,
    detail: { allowedRepos: normalized },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})
  return NextResponse.json({ allowedRepos: normalized })
}

export async function DELETE(req: NextRequest) {
  let user
  try { user = await requireWriteAccess() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await clearGithubToken(user.id)
  logAudit({
    userId: user.id,
    action: 'github_disconnect',
    target: `user:${user.id}`,
    detail: {},
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})
  return new NextResponse(null, { status: 204 })
}
