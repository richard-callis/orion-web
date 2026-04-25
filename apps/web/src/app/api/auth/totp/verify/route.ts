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

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { code } = body as { code?: string }

  if (!code || typeof code !== 'string' || code.length !== 6) {
    return NextResponse.json({ error: '6-digit code required' }, { status: 400 })
  }

  // Get the stored secret from the database
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { totpSecret: true, totpRecoveryCodes: true },
  })

  if (!dbUser?.totpSecret) {
    return NextResponse.json(
      { error: 'No pending TOTP setup. Call /api/auth/totp/generate first' },
      { status: 400 },
    )
  }

  // Verify the code against the server-stored secret
  if (!verifyTOTP(dbUser.totpSecret, code)) {
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

  return NextResponse.json({
    ok: true,
    message: 'MFA enabled successfully. Save your recovery codes in a safe place.',
  })
}
