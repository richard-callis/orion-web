/**
 * Rate limiting for credential-checking auth endpoints.
 *
 * `/api/auth` is a public path, so the proxy's generic `RATE_LIMITS['/api/auth']`
 * entry never ran — cross-account credential stuffing was only bounded by the
 * per-account lockout. The proxy applies this limit before its public-path
 * early return, and only to requests that verify a secret: next-auth's
 * session/csrf/providers GETs (polled by the UI) are never throttled.
 */

/** Paths whose POSTs verify a password, TOTP code or recovery code. */
export const AUTH_CREDENTIAL_PATHS = [
  '/api/auth/callback/credentials', // next-auth credentials sign-in (LoginForm → signIn('credentials'))
  '/api/auth/signin/credentials',
  '/api/auth/totp-login',
  '/api/auth/mfa/verify',
  '/api/auth/totp/verify',
] as const

/** Shared per-IP bucket across all credential endpoints: 10 attempts / 15 min. */
export const AUTH_CREDENTIAL_LIMIT = {
  bucket: 'auth-credentials',
  maxRequests: 10,
  windowMs: 15 * 60 * 1000,
} as const

export function isAuthCredentialRequest(pathname: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const path = pathname.replace(/\/+$/, '')
  return (AUTH_CREDENTIAL_PATHS as readonly string[]).includes(path)
}
