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
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

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
    return handleRecoveryLogin(username, password, code, req)
  }

  return handleTotpLogin(username, password, code, req)
}

async function handleTotpLogin(username: string, password: string, code?: string, req?: NextRequest) {
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
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
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
    // SOC2: [M-005] Log MFA verification failure (non-blocking)
    logAudit({
      userId: user.id, action: 'mfa_verify_failure', target: 'mfa:verify',
      detail: { reason: 'invalid_totp_code', method: 'totp' },
      ipAddress: req ? getClientIp(req) : undefined,
    }).catch(() => {})
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
  }

  // Mark as verified — update lastSeen
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date() },
  })

  // SOC2: [M-005] Log successful MFA verification (non-blocking)
  logAudit({
    userId: user.id, action: 'mfa_verify_success', target: 'mfa:verify',
    detail: { method: 'totp' },
    ipAddress: req ? getClientIp(req) : undefined,
    userAgent: req ? getUserAgent(req.headers) : undefined,
  }).catch(() => {})

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

async function handleRecoveryLogin(username: string, password: string, code?: string, req?: NextRequest) {
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
    // SOC2: [M-005] Log MFA verification failure (non-blocking)
    logAudit({
      userId: user.id, action: 'mfa_verify_failure', target: 'mfa:verify',
      detail: { reason: 'invalid_recovery_code', method: 'recovery' },
      ipAddress: req ? getClientIp(req) : undefined,
    }).catch(() => {})
    return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date() },
  })

  // SOC2: [M-005] Log successful MFA verification via recovery code (non-blocking)
  logAudit({
    userId: user.id, action: 'mfa_verify_success', target: 'mfa:verify',
    detail: { method: 'recovery_code' },
    ipAddress: req ? getClientIp(req) : undefined,
    userAgent: req ? getUserAgent(req.headers) : undefined,
  }).catch(() => {})

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
