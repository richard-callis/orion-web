import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, UpdateUserSchema } from '@/lib/validate'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const result = await parseBodyOrError(req, UpdateUserSchema)
  if ('error' in result) return result.error
  const { data } = result

  const updateData: Record<string, unknown> = {}
  if (data.role   !== undefined) updateData.role   = data.role
  if (data.active !== undefined) updateData.active = data.active
  if (data.username !== undefined) updateData.username = data.username
  if (data.email !== undefined) updateData.email = data.email
  if (data.password !== undefined) updateData.passwordHash = await hash(data.password, 14)
  if (data.name !== undefined) updateData.name = data.name

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
    select: {
      id: true, username: true, email: true, name: true,
      role: true, active: true, createdAt: true, lastSeen: true,
      totpEnabled: true,
      // explicitly exclude: passwordHash, totpSecret, totpSecretEncrypted, totpRecoveryCodes, totpRecoveryCodesEncrypted
    },
  })

  // SOC2: [M-005] Log user update (non-blocking)
  const detail: Record<string, unknown> = {}
  if (data.role   !== undefined) detail.roleChanged = { to: data.role }
  if (data.active !== undefined) detail.activeChanged = { to: data.active }
  logAudit({
    userId: admin.id,
    action: data.role !== undefined ? 'user_role_change' : 'user_update',
    target: `user:${params.id}`,
    detail,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  // SOC2: log password resets specifically
  if (data.password !== undefined) {
    logAudit({
      userId: admin.id,
      action: 'password_reset',
      target: `user:${params.id}`,
      detail: { resetBy: admin.id },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})
  }

  return NextResponse.json(user)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()

  // BLOCKER fix: prevent deleting the last admin or yourself, causing lockout.
  if (params.id === admin.id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }
  const adminCount = await prisma.user.count({ where: { role: 'admin', active: true } })
  const targetUser = await prisma.user.findUnique({ where: { id: params.id }, select: { role: true, username: true } })
  if (adminCount <= 1 && targetUser?.role === 'admin') {
    return NextResponse.json({ error: 'Cannot delete the last admin account — this would lock out all admin access' }, { status: 400 })
  }
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
