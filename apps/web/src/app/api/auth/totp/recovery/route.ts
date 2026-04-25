/**
 * POST /api/auth/totp/recovery — Generate new recovery codes
 *
 * Requires password re-confirmation for security.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { compare } from 'bcryptjs'
import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/totp'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { password } = body as { password?: string }

  if (!password) {
    return NextResponse.json({ error: 'Password required to regenerate recovery codes' }, { status: 400 })
  }

  // Verify password
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, totpEnabled: true },
  })

  if (!dbUser?.passwordHash) {
    return NextResponse.json(
      { error: 'Cannot regenerate recovery codes on accounts without password' },
      { status: 400 },
    )
  }

  if (!dbUser.totpEnabled) {
    return NextResponse.json({ error: 'MFA not enabled. Enable MFA first.' }, { status: 400 })
  }

  const valid = await compare(password, dbUser.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  // Generate new codes and hash them
  const recoveryCodes = generateRecoveryCodes()
  const hashedCodes = await Promise.all(
    recoveryCodes.map((rc) => hashRecoveryCode(rc)),
  )

  await prisma.user.update({
    where: { id: user.id },
    data: { totpRecoveryCodes: JSON.stringify(hashedCodes) },
  })

  return NextResponse.json({
    recoveryCodes,
    message: 'Recovery codes regenerated. Save them in a safe place.',
  })
}
