export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let admin
  try { admin = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } })
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rawToken = randomBytes(32).toString('hex')
  await prisma.agent.update({ where: { id }, data: { mcpToken: encrypt(rawToken) } })
  logAudit({
    userId: admin.id,
    action: 'mcp_token_rotate',
    target: `agent:${id}`,
    detail: {},
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})
  return NextResponse.json({ token: rawToken })
}
