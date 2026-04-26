/**
 * POST /api/auth/totp/generate — Generate TOTP secret + recovery codes
 *
 * SOC2 [M-002] Security:
 * - Stores the TOTP secret server-side (in totpSecret field, encrypted by middleware)
 * - Returns plaintext recovery codes ONCE — user must save them immediately
 * - Secret is NOT yet enabled (totpEnabled remains false until verify succeeds)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  generateSecretString,
  generateQRCodeUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/totp'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only admin and regular users can enable MFA
  if (user.role !== 'admin' && user.role !== 'user') {
    return NextResponse.json({ error: 'Only admins and users can enable MFA' }, { status: 403 })
  }

  // Generate TOTP secret
  const secret = generateSecretString()
  const qrCodeUrl = generateQRCodeUrl(secret, user.username)

  // Generate 8 recovery codes (plaintext, returned once)
  const recoveryCodes = generateRecoveryCodes()

  // Hash recovery codes for storage
  const hashedRecoveryCodes = await Promise.all(
    recoveryCodes.map((rc) => hashRecoveryCode(rc)),
  )

  // Store secret and hashed recovery codes temporarily
  // totpEnabled remains false until verification succeeds
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpSecret: secret,
      totpRecoveryCodes: JSON.stringify(hashedRecoveryCodes),
      // totpEnabled NOT set yet — only verified after code validation
    },
  })

  return NextResponse.json({
    qrCodeUrl,
    recoveryCodes,
    message: 'Scan the QR code with your authenticator app, then verify with a 6-digit code to enable MFA',
  })
}
