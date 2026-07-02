// SSO anti-replay nonce cache: maps nonce → expiry timestamp (ms)
const _ssoNonceCache = new Map<string, number>()

/**
 * Check that `nonce` has not been seen before and record it for `windowMs`.
 * Returns true (consume OK) or false (replay detected).
 * Evicts expired entries on each call to prevent unbounded growth.
 */
function _checkAndConsumeNonce(nonce: string, windowMs: number): boolean {
  const now = Date.now()
  for (const [k, exp] of _ssoNonceCache) {
    if (exp < now) _ssoNonceCache.delete(k)
  }
  if (_ssoNonceCache.has(nonce)) return false
  _ssoNonceCache.set(nonce, now + windowMs)
  return true
}

import { getServerSession, type NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { prisma } from './db'
import { verifyTOTP, verifyRecoveryCode, consumeRecoveryCode } from './totp'
import { createHmac, timingSafeEqual } from 'crypto'
import { logAudit } from './audit'
import { decrypt, decryptStrict } from './encryption'
import { sendNotification } from './security/notification-service'

export interface AppUser {
  id: string
  username: string
  email: string
  name: string | null
  role: string
  active: boolean
  totpEnabled?: boolean // SOC2: [M-002] whether this user has MFA enabled
  mfaVerified?: boolean // SOC2: [M-002] whether MFA was verified in this session
}

/**
 * SOC2: [M-002] MFA login state.
 * Returned from the TOTP login endpoint before creating a session.
 */
export type MfaLoginResult =
  | { status: 'mfa_required'; totpEnabled: true }
  | { status: 'mfa_recovery'; totpEnabled: true; codesRemaining: number }
  | { status: 'success'; user: AppUser }
  | { status: 'error'; message: string }

import { SESSION_COOKIE_NAME } from './auth-constants'
export { SESSION_COOKIE_NAME }

const IS_SECURE = process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https'

/**
 * SOC2: [M-006] Record a failed login attempt for a user.
 * Increments the counter; locks the account for 15 minutes after 5 failures.
 */
export async function recordFailedLogin(userId: string): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  })
  if (updated.failedLoginAttempts >= 5) {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000)
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil },
    })
    // SOC2: notify security team when an account is locked out
    void sendNotification({
      title: 'Account locked out',
      body: `Account ${userId} locked after 5 failed login attempts. Locked until ${lockedUntil.toISOString()}.`,
      priority: 4,
      tags: ['warning', 'lock'],
    }, { urgent: true })
  }
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  secret: process.env.NEXTAUTH_SECRET,
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: 'strict' as const,
        path: '/',
        secure: IS_SECURE,
      },
    },
    callbackUrl: {
      name: IS_SECURE ? '__Secure-next-auth.callback-url' : 'next-auth.callback-url',
      options: {
        sameSite: 'lax' as const,
        path: '/',
        secure: IS_SECURE,
      },
    },
    csrfToken: {
      name: IS_SECURE ? '__Host-next-auth.csrf-token' : 'next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: IS_SECURE,
      },
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
        totpCode: { label: 'TOTP Code', type: 'text' },
        isRecovery: { label: 'Is Recovery', type: 'hidden' },
      },
      async authorize(credentials): Promise<any> {
        if (!credentials?.username || !credentials?.password) return null

        const user = await prisma.user.findUnique({
          where: { username: credentials.username },
          select: {
            id: true, username: true, email: true, name: true,
            role: true, active: true, passwordHash: true,
            totpEnabled: true, totpSecret: true, totpSecretEncrypted: true,
            totpRecoveryCodes: true, totpRecoveryCodesEncrypted: true,
            failedLoginAttempts: true, lockedUntil: true, lastUsedTotpAt: true,
          },
        })

        if (!user || !user.active || !user.passwordHash) {
          // Constant-time: always run bcrypt to prevent user enumeration via timing
          await compare(credentials.password ?? '', '$2b$14$dummyhashfortimingnormalization000000000000000000000000')
          return null
        }

        // SOC2: [M-006] Check account lockout before attempting password verification
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          void logAudit({ userId: user.id, action: 'user_login_failure', target: user.id,
            detail: { reason: 'account_locked', lockedUntil: user.lockedUntil.toISOString() } })
          return null
        }

        const passwordValid = await compare(credentials.password, user.passwordHash)
        if (!passwordValid) {
          void logAudit({ userId: user.id, action: 'user_login_failure', target: user.id, detail: { reason: 'invalid_password' } })
          await recordFailedLogin(user.id)
          return null
        }

        // SOC2: [M-002] Check MFA requirement
        if (user.totpEnabled) {
          const isRecovery = credentials.isRecovery === 'true'

          if (isRecovery) {
            // Recovery code login
            const code = credentials.totpCode as string
            const rawCodes = user.totpRecoveryCodesEncrypted ? decryptStrict(user.totpRecoveryCodesEncrypted, 'totpRecoveryCodesEncrypted') : user.totpRecoveryCodes
            const hashedCodes: string[] = rawCodes ? JSON.parse(rawCodes) : []
            if (!code || !(await verifyRecoveryCode(code, hashedCodes))) {
              void logAudit({ userId: user.id, action: 'user_login_failure', target: user.id, detail: { reason: 'invalid_recovery_code' } })
              await recordFailedLogin(user.id)
              return null
            }
            // BLOCKER fix: consume the recovery code atomically inside a transaction
            // to prevent concurrent requests from both consuming the same code.
            const { encrypt: encryptFn } = await import('./encryption')
            const consumed = await prisma.$transaction(async (tx) => {
              const fresh = await tx.user.findUnique({
                where: { id: user.id },
                select: { totpRecoveryCodes: true, totpRecoveryCodesEncrypted: true },
              })
              const freshCodes: string[] = fresh?.totpRecoveryCodes ? JSON.parse(fresh.totpRecoveryCodes) : []
              const updatedCodes = await consumeRecoveryCode(code, freshCodes)
              if (!updatedCodes) return false  // code already consumed by concurrent request
              const writeData: Record<string, unknown> = { totpRecoveryCodes: JSON.stringify(updatedCodes) }
              if (process.env.ORION_ENCRYPTION_KEY && fresh?.totpRecoveryCodesEncrypted) {
                writeData.totpRecoveryCodesEncrypted = encryptFn(JSON.stringify(updatedCodes))
              }
              await tx.user.update({ where: { id: user.id }, data: writeData })
              return true
            })
            if (!consumed) return null  // concurrent request already used this code
          } else {
            // TOTP code login
            const code = credentials.totpCode as string
            const rawSecret = user.totpSecretEncrypted ? decryptStrict(user.totpSecretEncrypted, 'totpSecretEncrypted') : user.totpSecret
            if (!rawSecret) return null
            if (!code || typeof code !== 'string') {
              // No TOTP code provided — throw a detectable error so NextAuth returns
              // a login failure (no JWT minted) while the frontend can redirect to the
              // MFA entry screen. Returning a non-null object here would mint a valid
              // session without MFA verification (SOC2: CRITICAL-1 bypass).
              throw new Error('MFA_REQUIRED')
            }
            if (!(await verifyTOTP(rawSecret, code))) {
              void logAudit({ userId: user.id, action: 'user_login_failure', target: user.id, detail: { reason: 'invalid_totp' } })
              await recordFailedLogin(user.id)
              return null
            }
            // SOC2: [M-002] TOTP replay prevention — reject if same 30-second time step
            const currentStep = Math.floor(Date.now() / 30000)
            if (user.lastUsedTotpAt && Math.floor(user.lastUsedTotpAt.getTime() / 30000) === currentStep) {
              void logAudit({ userId: user.id, action: 'user_login_failure', target: user.id, detail: { reason: 'totp_replay' } })
              return null
            }
            await prisma.user.update({ where: { id: user.id }, data: { lastUsedTotpAt: new Date() } })
          }

          // MFA verified — reset lockout counters, update lastSeen, and return full user
          await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastSeen: new Date() } })
          void logAudit({ userId: user.id, action: 'user_login', target: user.id, detail: { mfaVerified: true } })
          return {
            id: user.id,
            name: user.name,
            email: user.email,
            username: user.username,
            role: user.role,
            totpEnabled: user.totpEnabled,
            mfaVerified: true,
          }
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: 0, lockedUntil: null, lastSeen: new Date() },
        })

        void logAudit({ userId: user.id, action: 'user_login', target: user.id, detail: { mfaVerified: false } })
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
          totpEnabled: user.totpEnabled,
          mfaVerified: false,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Fresh login — populate token from the authorized user object
        token.sub = user.id
        token.username = (user as AppUser & { username: string }).username
        token.role = (user as AppUser & { role: string }).role
        // SOC2: [M-002] Propagate MFA verified state from authorize()
        token.mfaVerified = (user as { mfaVerified?: boolean }).mfaVerified ?? false
        token.mfaVerifiedAt = Date.now()
        // SOC2: [CRITICAL-1] Propagate totpEnabled so the session callback gate is live
        token.totpEnabled = (user as AppUser & { totpEnabled?: boolean }).totpEnabled ?? false
      } else if (token.sub) {
        // Subsequent requests — verify the user still exists in the DB.
        // If the DB was wiped the user row is gone, so we invalidate the token
        // by clearing sub. Middleware treats token without sub as unauthenticated.
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { id: true, active: true, role: true, totpEnabled: true },
        })
        if (!dbUser || !dbUser.active) {
          token.sub = undefined
        } else {
          // Re-sync role from DB so demoted admins lose access immediately
          token.role = dbUser.role
          // SOC2 [M-002]: Re-sync totpEnabled so MFA enforcement activates immediately
          // after a user enables MFA, without waiting for session expiry.
          token.totpEnabled = dbUser.totpEnabled
        }
        // MFA verification expires after 15 minutes
        if (token.mfaVerifiedAt && token.mfaVerified) {
          const now = Date.now()
          if (now - (token.mfaVerifiedAt as number) > 15 * 60 * 1000) {
            token.mfaVerified = false
          }
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub as string
        session.user.username = token.username as string
        session.user.role = token.role as string
        // SOC2: [CRITICAL-1] Propagate totpEnabled so requireAdmin() gate is live
        ;(session.user as any).totpEnabled = token.totpEnabled as boolean ?? false
        ;(session.user as any).mfaVerified = token.mfaVerified as boolean ?? false
      }
      return session
    },
  },
  events: {
    async signOut({ token }: { token?: any }) {
      // SOC2: audit user logout
      if (token?.sub) {
        void logAudit({ userId: token.sub as string, action: 'user_logout', target: token.sub as string })
      }
    },
  },
}

/**
 * SOC2 [SSO-001]: Validate HMAC signature on SSO headers.
 *
 * Prevents header injection if reverse proxy is compromised.
 * Reverse proxy must sign headers with HMAC-SHA256:
 *   canonical_string = username|email|name|uid|timestamp
 *   signature = HMAC-SHA256(secret, canonical_string)
 *   x-authentik-hmac = base64(signature)
 *
 * @returns true if signature is valid and timestamp is recent (< 30 sec old)
 */
async function validateSSoHeaderHmac(headers: Headers): Promise<boolean> {
  const secret = process.env.SSO_HMAC_SECRET
  const secretPrevious = process.env.SSO_HMAC_SECRET_PREVIOUS  // for key rotation

  if (!secret) {
    // SOC2 [SSO-001]: HMAC secret not configured — reject SSO header auth to prevent
    // header injection if operator enabled header mode but forgot to set SSO_HMAC_SECRET.
    // Set SSO_ALLOW_UNSIGNED_SSO=true to allow unsigned headers during rollout only.
    const allowUnsigned = process.env.SSO_ALLOW_UNSIGNED_SSO === 'true'
    if (allowUnsigned) {
      console.warn('[SSO] SSO_HMAC_SECRET not configured but SSO_ALLOW_UNSIGNED_SSO=true — unsigned headers allowed')
      return true
    }
    return false
  }

  const username = headers.get('x-authentik-username')
  const email = headers.get('x-authentik-email')
  const name = headers.get('x-authentik-name')
  const uid = headers.get('x-authentik-uid')
  const timestamp = headers.get('x-authentik-timestamp')
  const signature = headers.get('x-authentik-hmac')
  const nonce = headers.get('x-authentik-nonce')

  // If signature header is missing but secret is set, reject (requires HMAC)
  if (!signature) {
    return false
  }

  // Check timestamp (30-second tolerance for clock skew)
  if (!timestamp) return false
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts)) return false
  const now = Date.now()
  const ageMs = now - ts
  if (ageMs > 30_000 || ageMs < -5_000) {
    // Reject if older than 30s or from future (clock skew tolerance: -5s)
    return false
  }

  // SOC2 [SSO-002]: Nonce handling for anti-replay protection.
  // SSO_NONCE_REQUIRED=true enforces nonce on all requests (fully deployed).
  // When flag is off (rollout mode), nonce is optional but used if present.
  const nonceRequired = process.env.SSO_NONCE_REQUIRED === 'true'
  const noncePresent = typeof nonce === 'string' && nonce.length >= 16

  if (nonceRequired && !noncePresent) {
    // Nonce enforcement is on — reject requests without a valid nonce
    return false
  }

  // Reconstruct canonical string (order matters!).
  // Include nonce only when it is present — old-format proxies omit it and
  // must produce a matching signature over the shorter canonical string.
  const canonical = noncePresent
    ? [username, email, name, uid, timestamp, nonce].join('|')
    : [username, email, name, uid, timestamp].join('|')

  if (!noncePresent) {
    console.warn('[SSO] x-authentik-nonce header absent — replay protection disabled. Upgrade proxy to include nonce or set SSO_NONCE_REQUIRED=true.')
  }

  // Try current secret first
  let expected: string
  try {
    expected = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex')
  } catch (err) {
    return false
  }

  // Timing-safe comparison against current secret
  // x-authentik-hmac carries the signature as base64 (per the contract above).
  try {
    const signatureBuf = Buffer.from(signature, 'base64')
    const expectedBuf = Buffer.from(expected, 'hex')
    if (signatureBuf.length !== expectedBuf.length) {
      // Try previous secret if configured (key rotation grace period)
      if (secretPrevious) {
        try {
          const expectedPrev = createHmac('sha256', secretPrevious)
            .update(canonical)
            .digest('hex')
          const expectedPrevBuf = Buffer.from(expectedPrev, 'hex')
          // timingSafeEqual returns false on mismatch (does NOT throw).
          // Capture the result — without this the return value was discarded
          // and return true was always reached, accepting any equal-length signature.
          if (!timingSafeEqual(signatureBuf, expectedPrevBuf)) return false
          // Previous-secret branch: consume nonce after successful verification
          if (noncePresent && !_checkAndConsumeNonce(nonce!, 35_000)) return false
          return true
        } catch {
          return false
        }
      }
      return false
    }
    // timingSafeEqual returns false on mismatch (does NOT throw).
    // The original code discarded the return value and always returned true
    // for any equal-length signature — a complete HMAC bypass.
    if (!timingSafeEqual(signatureBuf, expectedBuf)) return false
    // Primary-secret branch: consume nonce after successful verification.
    // TTL is 35 s (timestamp window is -5 s..+30 s = 35 s span).
    if (noncePresent && !_checkAndConsumeNonce(nonce!, 35_000)) return false
    return true
  } catch {
    return false
  }
}

export async function getCurrentUser(): Promise<AppUser | null> {
  // Primary: NextAuth JWT session
  const session = await getServerSession(authOptions)
  if (session?.user) {
    const sessionUser = session.user as AppUser & { mfaVerified?: boolean }
    return {
      id: session.user.id,
      username: session.user.username,
      email: session.user.email ?? '',
      name: session.user.name ?? null,
      role: session.user.role,
      active: true,
      totpEnabled: (session.user as AppUser & { totpEnabled?: boolean }).totpEnabled,
      mfaVerified: sessionUser.mfaVerified ?? false,
    }
  }

  // Optional SSO fallback: header-based (only if OIDCProvider.headerMode is enabled)
  try {
    const { headers } = await import('next/headers')
    const h = await headers()
    // SOC2 [LOW-2]: Only accept the signed x-authentik-username header.
    // x-forwarded-user is not included in the HMAC canonical string and must
    // not be used as a fallback — accepting it would bypass signature validation.
    const username = h.get('x-authentik-username')
    if (username) {
      const ssoProvider = await prisma.oIDCProvider.findFirst()
      if (ssoProvider?.enabled && ssoProvider?.headerMode) {
        // SOC2 [SSO-001]: Validate HMAC signature on SSO headers
        // This prevents header injection if the reverse proxy is compromised
        const hmacValid = await validateSSoHeaderHmac(h)
        if (!hmacValid) {
          // HMAC validation failed — reject the request
          // Log failed attempt for security monitoring
          try {
            const { getClientIp, getUserAgent } = await import('./audit')
            logAudit({
              userId: 'ANONYMOUS',  // Not yet authenticated
              action: 'user_login_failure',
              target: 'sso-header-auth',
              detail: { reason: 'invalid_hmac', username },
              ipAddress: getClientIp({ headers: h } as any),
              userAgent: getUserAgent(h),
            }).catch(() => {})  // Non-blocking
          } catch {}
          return null
        }

        const now = new Date()
        const user = await prisma.user.upsert({
          where: { username },
          update: { lastSeen: now },
          create: {
            username,
            email: h.get('x-authentik-email') ?? `${username}@sso`,
            name: h.get('x-authentik-name'),
            externalId: h.get('x-authentik-uid'),
            role: 'user',
            provider: 'authentik',
            lastSeen: now,
          },
        })
        // Derive new-vs-existing from the upsert result rather than a separate
        // pre-read findUnique — avoids a race where two concurrent first-time SSO
        // logins both read existingUser=null before either upsert commits.
        // A new user has createdAt === lastSeen (both just set); an existing user
        // has lastSeen updated but createdAt older.
        const isNewUser = user.lastSeen != null && Math.abs(user.createdAt.getTime() - user.lastSeen.getTime()) < 2000
        if (isNewUser) {
          void logAudit({
            userId: user.id,
            action: 'user_create',
            target: user.id,
            detail: { provider: 'sso', username, source: 'auto-provision' },
          })
        }
        if (!user.active) return null
        return user
      }
    }
  } catch {
    // Headers not available in this context — skip SSO fallback
  }

  return null
}

/**
 * SOC2: Require a logged-in user (any role). Throws if not logged in.
 */
export async function requireAuth(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user) throw new Error('Unauthorized')
  return user
}

/**
 * Use this for POST/PUT/DELETE handlers to block readonly users.
 */
export async function requireWriteAccess(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user) throw new Error('Unauthorized')
  if (user.role === 'readonly') throw new Error('Forbidden')
  return user
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') {
    throw new Error('Unauthorized')
  }
  // SOC2 [M-002]: If the user has MFA enabled, require it to be verified in this session.
  if (user.totpEnabled && !user.mfaVerified) {
    throw new Error('MFA verification required')
  }
  return user
}

/**
 * Require either a logged-in user OR the gateway service token.
 *
 * Returns the session user if authenticated via session, or null if
 * accessed via gateway service token (middleware already validated the token).
 *
 * Callers should handle the null case as "service/gateway auth".
 * Throws if neither session nor service token auth is present.
 */
export async function requireServiceAuth(
  req: { headers: Headers }
): Promise<AppUser | null> {
  const user = await getCurrentUser()
  if (user) return user

  // No session — check if this is a service token call
  // Middleware already validated the Bearer token, so if we get here
  // it's a gateway request. Detect it by checking for the service token header.
  const auth = req.headers.get('authorization')
  const gatewayToken = process.env.ORION_GATEWAY_TOKEN
  if (gatewayToken && auth) {
    const expected = `Bearer ${gatewayToken}`
    if (
      auth.length === expected.length &&
      timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      return null // service/gateway auth — caller should handle
    }
  }

  throw new Error('Unauthorized')
}

/**
 * Check if a user (or service) is authorized to modify a resource.
 *
 * Allows if:
 * - caller is the service/gateway (isService)
 * - the record has no owner (createdBy null/empty) → shared/system record, visible to all authenticated users
 * - caller is an admin
 * - caller created the resource
 */
export async function assertCanModify(
  user: AppUser | null,
  isService: boolean,
  recordCreatedBy: string | null
): Promise<void> {
  if (isService) return // gateway has full access
  if (!user) throw new Error('Unauthorized')
  // Null/empty owner = shared/system record. Any authenticated user may access it.
  if (!recordCreatedBy) return
  if (user.role === 'admin') return
  if (user.id === recordCreatedBy) return
  throw new Error('Forbidden')
}

/**
 * SOC2: Per-environment gateway token scoping.
 *
 * Validates that the Bearer token in the request matches the gateway token
 * for the specified environment. Prevents a token for env A from being used
 * to access env B's resources.
 *
 * Throws 'Unauthorized' if validation fails.
 */
export async function requireGatewayAuthForEnvironment(
  req: { headers: Headers },
  environmentId: string,
): Promise<void> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) throw new Error('Unauthorized')
  const bearerToken = auth.slice(7)

  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { gatewayToken: true },
  })
  if (!env?.gatewayToken) throw new Error('Unauthorized')

  // Use strict decrypt: if the stored token lacks the enc:v1: prefix, fail auth rather
  // than passing through the raw value. A plaintext gatewayToken allows a substitution
  // attack where an attacker writes a known plaintext and authenticates with it directly.
  const storedToken = decryptStrict(env.gatewayToken, 'gatewayToken')
  if (
    storedToken.length !== bearerToken.length ||
    !timingSafeEqual(Buffer.from(storedToken), Buffer.from(bearerToken))
  ) {
    throw new Error('Unauthorized')
  }
}
