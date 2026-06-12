/**
 * POST /api/auth/totp/verify — Verify TOTP code and enable MFA
 *
 * SOC2 [M-002] Security:
 * - Uses server-stored secret (from generate), NOT client-provided data
 * - Only enables MFA after successful code verification
 * - Recovery codes are now locked in (no more changes after this)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { verifyTOTP } from '@/lib/totp'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, TOTPVerifySchema } from '@/lib/validate'
import { decrypt } from '@/lib/encryption'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // SOC2: [INPUT-001] Validate request body
  const result = await parseBodyOrError(req, TOTPVerifySchema)
  if ('error' in result) return result.error
  const { data } = result  // { code: string }

  // Get the stored secret from the database
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { totpSecret: true, totpSecretEncrypted: true, totpRecoveryCodes: true },
  })

  const rawSecret = dbUser?.totpSecretEncrypted ? decrypt(dbUser.totpSecretEncrypted) : dbUser?.totpSecret
  if (!rawSecret) {
    return NextResponse.json(
      { error: 'No pending TOTP setup. Call /api/auth/totp/generate first' },
      { status: 400 },
    )
  }

  // Verify the code against the server-stored secret
  if (!(await verifyTOTP(rawSecret, data.code))) {
    return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 })
  }

  // Enable MFA — secret and recovery codes are now locked in
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpEnabled: true,
      totpEnabledAt: new Date(),
      // totpSecret and totpRecoveryCodes already set by generate
    },
  })

  // SOC2: [M-005] Log MFA enable (non-blocking)
  logAudit({
    userId: user.id,
    action: 'mfa_enable',
    target: `user:${user.id}`,
    detail: { username: user.username },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    message: 'MFA enabled successfully. Save your recovery codes in a safe place.',
  })
}
