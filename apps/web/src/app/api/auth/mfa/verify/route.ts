/**
 * MFA Verification Endpoint — SOC2 [M-002]
 *
 * Second step of MFA login: after password auth, verify TOTP code or recovery code.
 * Returns a JWT token with mfaVerified=true if successful.
 *
 * Flow:
 * 1. User enters username + password → authorize() succeeds
 * 2. Frontend calls this endpoint with TOTP code
 * 3. If valid, JWT is issued with mfaVerified flag
 * 4. User is now fully authenticated
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { compare } from 'bcryptjs'
import { verifyTOTP, verifyRecoveryCode } from '@/lib/totp'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { username, password, code, isRecovery } = body as {
    username?: string
    password?: string
    code?: string
    isRecovery?: boolean
  }

  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 })
  }

  if (isRecovery) {
    return handleRecoveryLogin(username, password, code)
  }

  return handleTotpLogin(username, password, code)
}

async function handleTotpLogin(username: string, password: string, code?: string) {
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'TOTP code required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true, username: true, email: true, name: true,
      role: true, active: true, passwordHash: true,
      totpEnabled: true, totpSecret: true,
    },
  })

  if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
    return NextResponse.json({ error: 'MFA not enabled for this account' }, { status: 403 })
  }

  // Verify password
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  const passwordValid = await compare(password, user.passwordHash)
  if (!passwordValid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify TOTP
  if (!verifyTOTP(user.totpSecret, code)) {
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
  }

  // Mark as verified — update lastSeen
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date() },
  })

  return NextResponse.json({
    ok: true,
    mfaVerified: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
}

async function handleRecoveryLogin(username: string, password: string, code?: string) {
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Recovery code required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true, username: true, email: true, name: true,
      role: true, active: true, passwordHash: true,
      totpEnabled: true, totpRecoveryCodes: true,
    },
  })

  if (!user || !user.active) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify password
  const passwordValid = await compare(password, user.passwordHash)
  if (!passwordValid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify recovery code
  const hashedCodes: string[] = user.totpRecoveryCodes ? JSON.parse(user.totpRecoveryCodes) : []
  if (!hashedCodes.length || !(await verifyRecoveryCode(code, hashedCodes))) {
    return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date() },
  })

  return NextResponse.json({
    ok: true,
    mfaVerified: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
}
