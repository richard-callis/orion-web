import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const body = await req.json()

  const updateData: Record<string, unknown> = {}
  if (body.role   !== undefined) updateData.role   = body.role
  if (body.active !== undefined) updateData.active = body.active

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
  })

  // SOC2: [M-005] Log user update (non-blocking)
  const detail: Record<string, unknown> = {}
  if (body.role   !== undefined) detail.roleChanged = { to: body.role }
  if (body.active !== undefined) detail.activeChanged = { to: body.active }
  logAudit({
    userId: admin.id,
    action: body.role !== undefined ? 'user_role_change' : 'user_update',
    target: `user:${params.id}`,
    detail,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json(user)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: { username: true },
  })
  await prisma.user.delete({ where: { id: params.id } })

  // SOC2: [M-005] Log user deletion (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'user_delete',
    target: `user:${params.id}`,
    detail: { username: user?.username },
    ipAddress: getClientIp(_req),
    userAgent: getUserAgent(_req.headers),
  }).catch(() => {})

  return new NextResponse(null, { status: 204 })
}
