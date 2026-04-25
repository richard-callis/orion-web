import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

// ─── Rate Limiting (SOC2: M-003) ─────────────────────────────────────────────
// Simple in-memory rate limiter. For production with multiple replicas,
// swap to Redis-backed (e.g., @upstash/ratelimit).

const rateLimitStore = new Map<string, number[]>()

function rateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now()
  const windowStart = now - windowMs

  // Get existing requests in window
  const existing = rateLimitStore.get(key) || []
  const recent = existing.filter(t => t > windowStart)

  if (recent.length >= maxRequests) {
    return false // rate limited
  }

  recent.push(now)
  rateLimitStore.set(key, recent)

  // Cleanup old entries every 100 requests
  if (recent.length % 100 === 0) {
    const cutoff = now - windowMs * 2
    for (const [k, timestamps] of rateLimitStore) {
      const filtered = timestamps.filter(t => t > cutoff)
      if (filtered.length === 0) {
        rateLimitStore.delete(k)
      } else {
        rateLimitStore.set(k, filtered)
      }
    }
  }

  return true
}

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

function applyRateLimit(req: NextRequest): NextResponse | null {
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
  if (!rateLimit(rateKey, maxRequests, windowMs)) {
    return NextResponse.json(
      { error: 'Too many requests, please try again later' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(windowMs / 1000)) } }
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // SOC2: [M-003] Apply rate limiting before auth check (prevents auth DoS)
  // Public endpoints that are rate-limited still get the check, others skip
  if (!PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    const rateLimited = applyRateLimit(req)
    if (rateLimited) return rateLimited
  }

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Gateway calls use Bearer token auth — let them through, routes handle validation.
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
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
}
