import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

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

// Prefixes that accept service token auth — any sub-path works
const SERVICE_TOKEN_PREFIXES = [
  '/api/notes',
  '/api/agent-groups',
  '/api/features',
  '/api/epics',
  '/api/tasks',
  '/api/bugs',
  '/api/admin',
]

// SOC2: [H-002, L-002] Security headers middleware
function addSecurityHeaders(res: NextResponse): NextResponse {
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

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Service token (gateway) calls — accept Bearer token instead of session.
  // Gateway tools need to read/write notes, list agent-groups, etc.
  const gatewayToken = process.env.ORION_GATEWAY_TOKEN
  if (
    gatewayToken &&
    req.headers.get('authorization') === `Bearer ${gatewayToken}`
  ) {
    // Gateway can do anything except DELETE on notes (safety)
    if (req.method === 'DELETE' && pathname.startsWith('/api/notes')) {
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
