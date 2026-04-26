import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

// SOC2: [M-004] Wrap console.log BEFORE any other import to catch all log output
import { wrapConsoleLog } from './lib/redact'
wrapConsoleLog()

// ─── Rate Limiting (SOC2: M-003) ─────────────────────────────────────────────
// Redis-backed sliding window rate limiter with in-memory fallback.
// See: src/lib/rate-limit-redis.ts

import { rateLimitRedis } from './lib/rate-limit-redis'

function getRateLimitKey(req: NextRequest): string {
  // Use X-Forwarded-For if available (behind reverse proxy), else IP
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs: client, proxy1, proxy2
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

// Per-path rate limit configs: [maxRequests, windowMs]
const RATE_LIMITS: Record<string, [number, number]> = {
  // Auth endpoints — strict limit to prevent brute-force
  '/login': [10, 15 * 60 * 1000],
  '/api/setup': [10, 15 * 60 * 1000],
  '/api/auth': [10, 15 * 60 * 1000],

  // Chat/streaming — moderate limit (cost control for LLM calls)
  '/api/chat': [30, 15 * 60 * 1000],
  '/api/k8s': [30, 15 * 60 * 1000],

  // Webhooks — higher limit (they're automated)
  '/api/webhooks': [60, 15 * 60 * 1000],

  // Tool generation — moderate limit (cost control)
  '/api/tools/generate': [20, 15 * 60 * 1000],

  // Default — global limit
  'default': [100, 15 * 60 * 1000],
}

async function applyRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const key = getRateLimitKey(req)
  const { pathname } = req.nextUrl

  // Find the most specific rate limit config for this path
  let maxRequests = RATE_LIMITS['default']?.[0] ?? 100
  let windowMs = RATE_LIMITS['default']?.[1] ?? 15 * 60 * 1000

  for (const [path, [max, window]] of Object.entries(RATE_LIMITS)) {
    if (path !== 'default' && pathname.startsWith(path)) {
      maxRequests = max
      windowMs = window
      break
    }
  }

  const rateKey = `${key}:${pathname}`
  if (!(await rateLimitRedis(rateKey, maxRequests, windowMs))) {
    return NextResponse.json(
      { error: 'Too many requests, please try again later' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(windowMs / 1000)) } }
    )
  }

  return null
}

/**
 * SOC2: [M-003] Rate limit SSO header auth requests.
 * Prevents brute-force user creation via x-authentik-username / x-forwarded-user headers.
 * Uses IP-based rate limiting (5 req/min per IP).
 */
async function applySsoRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const ip = getRateLimitKey(req)
  const key = `sso-rate:${ip}`
  // 5 requests per minute per IP
  if (!(await rateLimitRedis(key, 5, 60_000))) {
    return NextResponse.json(
      { error: 'Too many requests — SSO authentication rate limited' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }
  return null
}

const PUBLIC_PATHS = [
  '/setup',
  '/login',
  '/api/setup',
  '/api/auth',
  '/api/health',
  '/api/notes/embed',       // embed rebuild — bypassed via x-embed-token header
  '/api/environments/join', // gateway registration — no session, token IS the auth
  '/api/webhooks',          // git provider webhooks — HMAC signature is the auth
  '/_next',
  '/favicon.ico',
]

// API routes that may use x-api-key header — pass through, route handles auth
const API_KEY_PATHS = ['/api/api-keys']

// API routes that use Bearer token auth — middleware passes through,
// route handlers validate the token themselves
const BEARER_PATHS = [
  '/api/environments',
  '/api/internal',     // internal service-to-service routes (e.g. vault-unsealer)
]

// SOC2: [H-002, L-002] Security headers middleware
function addSecurityHeaders(res: NextResponse): NextResponse {
  // CSP: style-src 'unsafe-inline' required because React/Next.js uses inline styles
  res.headers.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'strict-dynamic'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https:; " +
    "font-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'; " +
    "upgrade-insecure-requests"
  )
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-XSS-Protection', '1; mode=block')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  )

  // HSTS — only in production
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  }

  return res
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // SOC2: [M-003] Apply rate limiting before auth check (prevents auth DoS)
  // Public endpoints that are rate-limited still get the check, others skip
  if (!PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    const rateLimited = await applyRateLimit(req)
    if (rateLimited) return rateLimited
  }

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // SOC2: Rate limit SSO header auth — prevents brute-force user creation
  // via x-forwarded-user / x-authentik-username headers on non-authenticated requests
  const ssoUser = req.headers.get('x-authentik-username') ?? req.headers.get('x-forwarded-user')
  if (ssoUser && !req.headers.get('cookie')?.includes('next-auth.session-token')) {
    const ssoRateLimited = await applySsoRateLimit(req)
    if (ssoRateLimited) return ssoRateLimited
  }

  // Service token (gateway) calls — accept Bearer token instead of session.
  // Gateway tools need to read/write notes, list agent-groups, etc.
  // SOC2: /api/admin/* is NEVER accessible via gateway token — always requires session auth
  const gatewayToken = process.env.ORION_GATEWAY_TOKEN
  if (
    gatewayToken &&
    req.headers.get('authorization') === `Bearer ${gatewayToken}`
  ) {
    // Admin routes always require session auth — never bypassable
    if (pathname.startsWith('/api/admin')) {
      // fall through to session auth
    }
    // Gateway can do anything except DELETE on notes (safety)
    else if (req.method === 'DELETE' && pathname.startsWith('/api/notes')) {
      // fall through to session auth for DELETE on notes
    } else {
      return NextResponse.next()
    }
  }

  // Legacy: Bearer token auth for specific paths — let them through, routes handle validation.
  // DELETE is never a gateway operation and must always require a session.
  if (
    req.method !== 'DELETE' &&
    BEARER_PATHS.some(p => pathname.startsWith(p)) &&
    req.headers.get('authorization')?.startsWith('Bearer ')
  ) {
    return NextResponse.next()
  }

  // API key routes — pass through, route handler handles all auth
  if (API_KEY_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Cookie name must match what auth.ts configures (no __Secure- prefix — works over HTTP and HTTPS)
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' })
  if (!token || !token.sub) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    const res = NextResponse.redirect(loginUrl)
    return addSecurityHeaders(res)
  }

  const res = NextResponse.next()
  return addSecurityHeaders(res)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
}
