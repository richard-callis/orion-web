/**
 * TOTP Login Verification — SOC2 [M-002]
 *
 * Used as the second step in MFA-enabled login flows:
 * 1. User enters username + password → authorize() returns MFA_REQUIRED
 * 2. User enters TOTP code → this endpoint verifies and returns session token
 *
 * Also supports recovery code login (used when TOTP token is unavailable).
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
    // Recovery code login
    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'Recovery code required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        active: true,
        passwordHash: true,
        totpEnabled: true,
        totpRecoveryCodes: true,
      },
    })

    if (!user || !user.active) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Verify password
    if (!user.passwordHash) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }
    const valid = await compare(password, user.passwordHash)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Verify recovery code
    const hashedCodes: string[] = user.totpRecoveryCodes ? JSON.parse(user.totpRecoveryCodes) : []
    if (!hashedCodes.length || !(await verifyRecoveryCode(code, hashedCodes))) {
      // SOC2: [M-005] Log MFA verification failure (non-blocking)
      logAudit({
        userId: user.id, action: 'mfa_verify_failure', target: 'mfa:recovery',
        detail: { method: 'recovery_code', reason: 'invalid_code' },
        ipAddress: getClientIp(req),
      }).catch(() => {})
      return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
    }

    // Update last seen
    await prisma.user.update({
      where: { id: user.id },
      data: { lastSeen: new Date() },
    })

    // SOC2: [M-005] Log successful recovery code login (non-blocking)
    logAudit({
      userId: user.id, action: 'user_login', target: 'auth:totp-login',
      detail: { method: 'recovery_code' },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json({
      status: 'success',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
  }

  // TOTP code login
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'TOTP code required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      role: true,
      active: true,
      passwordHash: true,
      totpEnabled: true,
      totpSecret: true,
    },
  })

  if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify password
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  const valid = await compare(password, user.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify TOTP code
  if (!verifyTOTP(user.totpSecret, code)) {
    // SOC2: [M-005] Log MFA verification failure (non-blocking)
    logAudit({
      userId: user.id, action: 'mfa_verify_failure', target: 'mfa:totp',
      detail: { reason: 'invalid_totp_code' },
      ipAddress: getClientIp(req),
    }).catch(() => {})
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
  }

  // Update last seen
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date() },
  })

  // SOC2: [M-005] Log successful TOTP login (non-blocking)
  logAudit({
    userId: user.id, action: 'user_login', target: 'auth:totp-login',
    detail: { method: 'totp' },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({
    status: 'success',
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
}
