/**
 * POST /api/auth/totp/disable — Disable TOTP MFA
 *
 * Requires password re-confirmation for security.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { compare } from 'bcryptjs'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, TOTPDisableSchema } from '@/lib/validate'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, TOTPDisableSchema)
  if ('error' in result) return result.error

  const { data } = result  // { password: string }

  // Verify password
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  })

  if (!dbUser?.passwordHash) {
    return NextResponse.json(
      { error: 'Cannot disable MFA on accounts without password' },
      { status: 400 },
    )
  }

  const valid = await compare(data.password, dbUser.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  // Disable MFA and clear all TOTP data
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpEnabled: false,
      totpSecret: null,
      totpRecoveryCodes: null,
      totpEnabledAt: null,
    },
  })

  // SOC2: [M-005] Log MFA disable (non-blocking)
  logAudit({
    userId: user.id,
    action: 'mfa_disable',
    target: `user:${user.id}`,
    detail: { username: user.username },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    message: 'MFA disabled',
  })
}
