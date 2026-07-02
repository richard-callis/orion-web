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
import { verifyTOTP, verifyRecoveryCode, consumeRecoveryCode } from '@/lib/totp'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, TOTPLoginSchema } from '@/lib/validate'
import { rateLimitRedis, getClientIpForRateLimit } from '@/lib/rate-limit-redis'
import { decryptStrict, encrypt } from '@/lib/encryption'
import { recordFailedLogin } from '@/lib/auth'

export async function POST(req: NextRequest) {
  // SOC2 [M-007]: Rate-limit TOTP/recovery brute-force attempts.
  // Must run before any verification so attackers cannot enumerate codes unchecked.
  // Limit: 10 attempts per IP per 15-minute window.
  const ip = getClientIpForRateLimit(req)
  const { allowed: rlAllowed } = await rateLimitRedis(`totp-login:${ip}`, 10, 15 * 60 * 1000)
  if (!rlAllowed) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 })
  }

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, TOTPLoginSchema)
  if ('error' in result) return result.error

  const { data } = result  // { username, password, code?, isRecovery? }

  if (data.isRecovery) {
    // Recovery code login
    if (!data.code || typeof data.code !== 'string') {
      return NextResponse.json({ error: 'Recovery code required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { username: data.username },
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
        totpRecoveryCodesEncrypted: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    })

    if (!user || !user.active) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // SOC2: [M-006] Check account lockout before any verification
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return NextResponse.json({ error: 'Account locked. Try again later.' }, { status: 401 })
    }

    // Verify password
    if (!user.passwordHash) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }
    const valid = await compare(data.password, user.passwordHash)
    if (!valid) {
      await recordFailedLogin(user.id)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Verify recovery code — prefer encrypted field
    let rawCodes: string | null = null
    if (user.totpRecoveryCodesEncrypted) {
      try { rawCodes = decryptStrict(user.totpRecoveryCodesEncrypted, 'totpRecoveryCodesEncrypted') } catch { return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 }) }
    } else {
      rawCodes = user.totpRecoveryCodes
    }
    const hashedCodes: string[] = rawCodes ? JSON.parse(rawCodes) : []
    if (!hashedCodes.length || !(await verifyRecoveryCode(data.code, hashedCodes))) {
      // SOC2: [M-005] Log MFA verification failure (non-blocking)
      logAudit({
        userId: user.id, action: 'mfa_verify_failure', target: 'mfa:recovery',
        detail: { method: 'recovery_code', reason: 'invalid_code' },
        ipAddress: getClientIp(req),
      }).catch(() => {})
      await recordFailedLogin(user.id)
      return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
    }

    // SOC2: [M-002] Atomically consume the recovery code inside a transaction to prevent
    // concurrent requests from both consuming the same code (TOCTOU race condition fix).
    const consumed = await prisma.$transaction(async (tx) => {
      const fresh = await tx.user.findUnique({
        where: { id: user.id },
        select: { totpRecoveryCodes: true, totpRecoveryCodesEncrypted: true },
      })
      const freshRaw = fresh?.totpRecoveryCodesEncrypted ? decryptStrict(fresh.totpRecoveryCodesEncrypted, 'totpRecoveryCodesEncrypted') : fresh?.totpRecoveryCodes
      const freshCodes: string[] = freshRaw ? JSON.parse(freshRaw) : []
      const updatedCodes = await consumeRecoveryCode(data.code!, freshCodes)
      if (!updatedCodes) return false  // code already consumed by concurrent request
      const updatedCodesJson = JSON.stringify(updatedCodes)
      const writeData: Record<string, unknown> = { totpRecoveryCodes: updatedCodesJson, lastSeen: new Date() }
      if (process.env.ORION_ENCRYPTION_KEY && fresh?.totpRecoveryCodesEncrypted) {
        writeData.totpRecoveryCodesEncrypted = encrypt(updatedCodesJson)
      }
      await tx.user.update({ where: { id: user.id }, data: writeData })
      return true
    })
    if (!consumed) {
      return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
    }

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
  if (!data.code || typeof data.code !== 'string') {
    return NextResponse.json({ error: 'TOTP code required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { username: data.username },
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
      totpSecretEncrypted: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      lastUsedTotpAt: true,
    },
  })

  let rawSecret: string | null | undefined = null
  if (user?.totpSecretEncrypted) {
    try { rawSecret = decryptStrict(user.totpSecretEncrypted, 'totpSecretEncrypted') } catch { return NextResponse.json({ error: 'MFA not enabled for this account' }, { status: 403 }) }
  } else {
    rawSecret = user?.totpSecret
  }
  if (!user || !user.active || !user.totpEnabled || !rawSecret) {
    return NextResponse.json({ error: 'MFA not enabled for this account' }, { status: 403 })
  }

  // SOC2: [M-006] Check account lockout before any verification
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return NextResponse.json({ error: 'Account locked. Try again later.' }, { status: 401 })
  }

  // Verify password
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  const valid = await compare(data.password, user.passwordHash)
  if (!valid) {
    await recordFailedLogin(user.id)
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Verify TOTP code
  if (!(await verifyTOTP(rawSecret, data.code))) {
    // SOC2: [M-005] Log MFA verification failure (non-blocking)
    logAudit({
      userId: user.id, action: 'mfa_verify_failure', target: 'mfa:totp',
      detail: { reason: 'invalid_totp_code' },
      ipAddress: getClientIp(req),
    }).catch(() => {})
    await recordFailedLogin(user.id)
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
  }

  // SOC2: [M-002] TOTP replay prevention — reject if same 30-second time step
  const currentStep = Math.floor(Date.now() / 30000)
  if (user.lastUsedTotpAt && Math.floor(user.lastUsedTotpAt.getTime() / 30000) === currentStep) {
    logAudit({
      userId: user.id, action: 'mfa_verify_failure', target: 'mfa:totp',
      detail: { reason: 'totp_replay' },
      ipAddress: getClientIp(req),
    }).catch(() => {})
    return NextResponse.json({ error: 'TOTP code already used. Wait for next code.' }, { status: 401 })
  }

  // Update last seen and lastUsedTotpAt
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeen: new Date(), lastUsedTotpAt: new Date() },
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
