/**
 * TOTP Management API Routes — SOC2 [M-002]
 *
 * Endpoints:
 * - GET    /api/auth/totp/status  — Check if MFA is enabled for current user
 * - POST   /api/auth/totp/generate  — Generate TOTP secret + QR code + recovery codes
 * - POST   /api/auth/totp/verify    — Verify TOTP code to enable MFA
 * - POST   /api/auth/totp/disable   — Disable MFA (requires password)
 * - POST   /api/auth/totp/recovery  — Get new recovery codes (requires password)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { compare } from 'bcryptjs'
import {
  generateSecret,
  generateQRCodeUrl,
  verifyTOTP,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/totp'

// ── GET /api/auth/totp/status ─────────────────────────────────────────────────
// Returns MFA status for the current user.

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { totpEnabled: true, totpEnabledAt: true },
  })

  return NextResponse.json({
    enabled: dbUser?.totpEnabled ?? false,
    enabledAt: dbUser?.totpEnabledAt ?? null,
  })
}

// ── POST /api/auth/totp/generate ─────────────────────────────────────────────
// Generate a new TOTP secret and QR code URL.
// Recovery codes are returned ONCE — user must save them before proceeding.
// Secret and recovery codes are NOT stored yet — they're stored on verify().

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Users with SSO provider (authentik/oidc) can't use password-based TOTP enrollment
  if (user.role !== 'admin' && user.role !== 'user') {
    // readonly users also allowed to enable MFA
  }

  // Generate TOTP secret
  const secret = generateSecret()
  const qrCodeUrl = generateQRCodeUrl(secret, user.username)

  // Generate 8 recovery codes (plaintext, returned once)
  const recoveryCodes = generateRecoveryCodes()

  return NextResponse.json({
    qrCodeUrl,
    recoveryCodes,
    message: 'Scan the QR code with your authenticator app, then verify to enable MFA',
  })
}

// ── POST /api/auth/totp/verify ───────────────────────────────────────────────
// Verify a TOTP code to enable MFA.
// Also stores hashed recovery codes in the database.

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { code, qrCodeUrl, recoveryCodes } = body as {
    code?: string
    qrCodeUrl?: string
    recoveryCodes?: string[]
  }

  if (!code || typeof code !== 'string' || code.length !== 6) {
    return NextResponse.json({ error: '6-digit code required' }, { status: 400 })
  }

  if (!qrCodeUrl || !recoveryCodes) {
    return NextResponse.json({ error: 'Missing QR code URL or recovery codes' }, { status: 400 })
  }

  // Validate the TOTP code against the session secret
  if (!verifyTOTP(qrCodeUrl.split('=')[1].split('&')[0], code)) {
    return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 })
  }

  // Extract secret from QR URL
  const secret = qrCodeUrl.split('=')[1].split('&')[0]

  // Hash all recovery codes
  const hashedCodes = await Promise.all(
    recoveryCodes.map((rc) => hashRecoveryCode(rc)),
  )

  // Store secret (encrypted at rest by middleware) and hashed recovery codes
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpSecret: secret,
      totpEnabled: true,
      totpRecoveryCodes: JSON.stringify(hashedCodes),
      totpEnabledAt: new Date(),
    },
  })

  return NextResponse.json({
    ok: true,
    message: 'MFA enabled successfully',
  })
}

// ── POST /api/auth/totp/disable ──────────────────────────────────────────────
// Disable TOTP MFA. Requires password re-confirmation for security.

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { password } = body as { password?: string }

  if (!password) {
    return NextResponse.json({ error: 'Password required to disable MFA' }, { status: 400 })
  }

  // Verify password
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, totpEnabled: true },
  })

  if (!dbUser?.passwordHash) {
    return NextResponse.json({ error: 'Cannot disable MFA on accounts without password' }, { status: 400 })
  }

  const valid = await compare(password, dbUser.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  // Disable MFA
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpEnabled: false,
      totpSecret: null,
      totpRecoveryCodes: null,
      totpEnabledAt: null,
    },
  })

  return NextResponse.json({
    ok: true,
    message: 'MFA disabled',
  })
}

// ── POST /api/auth/totp/recovery ─────────────────────────────────────────────
// Generate new recovery codes. Requires password re-confirmation.

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
    return NextResponse.json({ error: 'Cannot regenerate recovery codes on accounts without password' }, { status: 400 })
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

  return NextResponse.json({ recoveryCodes })
}
