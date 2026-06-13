import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getOrCreateCorrelationId } from './lib/correlation-id'

// SOC2: [M-004] Wrap console.log BEFORE any other import to catch all log output
import { wrapConsoleLog } from './lib/redact'
wrapConsoleLog()

// ─── Rate Limiting (SOC2: M-003) ─────────────────────────────────────────────
// Redis-backed sliding window rate limiter with in-memory fallback.
// See: src/lib/rate-limit-redis.ts

import { rateLimitRedis, getClientIpForRateLimit } from './lib/rate-limit-redis'
import { isIpBlocked } from './lib/security/crowdsec-bouncer'
import { SESSION_COOKIE_NAME } from './lib/auth-constants'

function getRateLimitKey(req: NextRequest): string {
  // SOC2: [M-006] Use x-forwarded-for first so self-hosted Node deployments
  // (where req.ip is always undefined) correctly isolate rate-limit buckets
  // per client rather than lumping every request into 'unknown'.
  return getClientIpForRateLimit(req)
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

  // Webhooks — per-IP limit applied separately inside webhook handler (keyed by triggerId)
  // SOC2: [H-001] This entry is intentionally kept for fallback/documentation purposes;
  // the actual enforcement is done per-trigger inside the webhook route handler.
  '/api/webhooks': [60, 15 * 60 * 1000],

  // Tool generation — moderate limit (cost control)
  '/api/tools/generate': [20, 15 * 60 * 1000],

  // Task creation — tight limit (each task spawns LLM work)
  // SOC2: [M-001] 20 task creations per minute per IP/user
  '/api/tasks': [20, 60 * 1000],

  // Note search — higher limit for read-heavy workloads (must be listed BEFORE /api/notes
  // so the more-specific path wins the prefix match in applyRateLimit)
  // SOC2: [M-003] 60 note searches per minute
  '/api/notes/search': [60, 60 * 1000],

  // Note CRUD — moderate write limit
  // SOC2: [M-002] 30 note writes per minute
  '/api/notes': [30, 60 * 1000],

  // UI polling endpoints — high limit (browser polls every few seconds)
  '/api/jobs': [2000, 15 * 60 * 1000],
  '/api/agents': [2000, 15 * 60 * 1000],
  // Claude auth admin page polls /api/admin/claude/oauth?action=poll every 1.5s
  // during login. Without a dedicated limit it exhausts the default bucket and
  // every subsequent call (including ?action=login) gets a 429.
  '/api/admin/claude': [2000, 15 * 60 * 1000],

  // Default — global limit
  'default': [100, 15 * 60 * 1000],
}

async function applyRateLimit(req: NextRequest, userId?: string): Promise<NextResponse | null> {
  const ip = getRateLimitKey(req)
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

  // SOC2: [H-002] Primary IP-based rate limit (spoofing-resistant via TRUSTED_PROXY_COUNT)
  const ipRateKey = `rate-limit:ip:${ip}:${pathname}`
  const ipResult = await rateLimitRedis(ipRateKey, maxRequests, windowMs)

  if (!ipResult.allowed) {
    const retryAfterSeconds = Math.ceil((ipResult.resetAt.getTime() - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too many requests, please try again later' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(ipResult.limit),
          'X-RateLimit-Remaining': String(ipResult.remaining),
          'X-RateLimit-Reset': ipResult.resetAt.toISOString(),
          'Retry-After': String(Math.max(1, retryAfterSeconds)),
        },
      }
    )
  }

  // SOC2: [H-002] Secondary per-user rate limit for authenticated requests.
  // A user who rotates IPs (VPN, mobile) still gets per-account quota enforcement.
  if (userId) {
    const userRateKey = `rate-limit:user:${userId}:${pathname}`
    const userResult = await rateLimitRedis(userRateKey, maxRequests, windowMs)
    if (!userResult.allowed) {
      const retryAfterSeconds = Math.ceil((userResult.resetAt.getTime() - Date.now()) / 1000)
      return NextResponse.json(
        { error: 'Too many requests, please try again later' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(userResult.limit),
            'X-RateLimit-Remaining': String(userResult.remaining),
            'X-RateLimit-Reset': userResult.resetAt.toISOString(),
            'Retry-After': String(Math.max(1, retryAfterSeconds)),
          },
        }
      )
    }
  }

  return null
}

const PUBLIC_PATHS = [
  '/setup',
  '/login',
  '/api/setup',
  '/api/auth',
  '/api/health',
  '/api/notes/embed/rebuild', // embed rebuild — bypassed via x-embed-token header; scoped to exact path to avoid auto-exempting future /api/notes/embed* routes
  '/api/environments/join', // gateway registration — no session, token IS the auth
  '/api/webhooks',          // git provider webhooks — HMAC signature is the auth
  '/api/monitoring/security/webhooks', // security source webhooks (Falco, CrowdSec, Wazuh) — HMAC is the auth
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

// ─── SOC2: [H-002, L-002, CSP-001] Nonce-based Content Security Policy ──────
//
// Every request gets a unique cryptographic nonce. Only scripts and styles
// bearing that nonce are allowed to execute. This eliminates XSS via injected
// inline scripts while allowing Next.js's own SSR-generated scripts to run.
//
// How it works:
//   1. Middleware generates a 128-bit random nonce (base64-encoded)
//   2. CSP header is set on BOTH request headers (so Next.js SSR can read
//      the nonce and inject it into <script>/<style> tags it generates)
//      AND response headers (so the browser enforces the policy)
//   3. 'strict-dynamic' allows scripts loaded by a nonce'd script to also
//      execute — this covers Next.js chunk loading without whitelisting URLs
//   4. 'self' and 'unsafe-inline' are included as CSP Level 2 fallbacks —
//      in Level 3 browsers, they are ignored when nonce + strict-dynamic
//      are present (per spec)
//
// References:
//   - https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
//   - https://web.dev/strict-csp/
//   - CSP Level 3 spec §8.1 (strict-dynamic usage)

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    // connect-src: restrict to known origins; operators can extend via CONNECT_SRC_EXTRA
    // (space-separated list of origins, e.g. "https://my-gateway.example.com wss://my-gateway.example.com")
    `connect-src 'self' https://api.anthropic.com${process.env.CONNECT_SRC_EXTRA ? ' ' + process.env.CONNECT_SRC_EXTRA : ''}`,
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join('; ')
}

function addSecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set('Content-Security-Policy', buildCsp(nonce))
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-XSS-Protection', '0') // deprecated; modern browsers use CSP instead
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

/** Create a NextResponse.next() that carries the nonce and correlation ID in request headers.
 *  Nonce: injected into generated <script>/<style> tags by Next.js SSR
 *  Correlation ID: used for error tracking and request debugging (SOC2 [H-002]) */
function nextWithNonce(req: NextRequest, nonce: string, correlationId: string): NextResponse {
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('x-correlation-id', correlationId)
  requestHeaders.set('Content-Security-Policy', buildCsp(nonce))
  return NextResponse.next({ request: { headers: requestHeaders } })
}

/** Constant-time string comparison to prevent timing attacks on token auth (SOC2 #166) */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ── Generate per-request nonce (SOC2: CSP-001) ────────────────────────────
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')

  // ── Generate correlation ID for error tracking (SOC2: [H-002]) ──────────────
  const correlationId = getOrCreateCorrelationId(Object.fromEntries(req.headers))

  // ── CrowdSec IP block check ────────────────────────────────────────────────
  // Skip for security webhooks (CrowdSec POSTs to us) and health checks —
  // blocking those would create a feedback loop or break monitoring.
  const isCrowdSecWebhook = pathname.startsWith('/api/monitoring/security/webhooks')
  const isHealthCheck     = pathname === '/api/health'
  if (!isCrowdSecWebhook && !isHealthCheck) {
    const clientIp = getClientIpForRateLimit(req)
    const blocked = await isIpBlocked(clientIp).catch(() => false)
    if (blocked) {
      return new NextResponse('Forbidden', { status: 403 })
    }
  }

  // SOC2: [H-001] Rate-limit webhook paths before the PUBLIC_PATHS early-return.
  // Webhooks are in PUBLIC_PATHS (HMAC is their auth), but without this check the
  // RATE_LIMITS entry for '/api/webhooks' was dead code — the early-return below
  // would fire first, skipping applyRateLimit entirely. We apply it here so an
  // attacker with a valid secret cannot flood the endpoint.
  // The per-trigger quota is enforced inside the route handler (60 req/15 min keyed
  // by triggerId); this IP-level check is an additional outer guard.
  if (pathname.startsWith('/api/webhooks') || pathname.startsWith('/api/monitoring/security/webhooks')) {
    const rateLimited = await applyRateLimit(req)
    if (rateLimited) return addSecurityHeaders(rateLimited, nonce)
  }

  // Decode session JWT once — reused for rate limit userId and auth redirect below.
  // getToken is a fast local JWT decode (no DB call).
  // For public paths this will usually return null — that's fine.
  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p))
  const sessionToken = isPublicPath
    ? null
    : await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: SESSION_COOKIE_NAME })

  // SOC2: [M-003] Apply rate limiting before auth check (prevents auth DoS)
  // Public endpoints that are rate-limited still get the check, others skip
  if (!isPublicPath) {
    // Pass userId for secondary per-user quota enforcement (SOC2: [H-002])
    const rateLimited = await applyRateLimit(req, sessionToken?.sub ?? undefined)
    if (rateLimited) return addSecurityHeaders(rateLimited, nonce)
  }

  if (isPublicPath) {
    return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
  }

  // MCP service calls — x-mcp-token header is the auth, route handler validates value.
  const mcpToken = process.env.ORION_MCP_TOKEN
  if (
    pathname.startsWith('/api/mcp') &&
    mcpToken &&
    timingSafeCompare(req.headers.get('x-mcp-token') ?? '', mcpToken)
  ) {
    return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
  }

  // Executor service calls — x-executor-token header is the auth.
  // Executor logs execution records and reads them for status polling.
  // Use constant-time comparison to prevent timing attacks (SOC2 #166)
  const executorToken = process.env.ORION_EXECUTOR_TOKEN
  if (
    pathname.startsWith('/api/executions') &&
    executorToken &&
    timingSafeCompare(req.headers.get('x-executor-token') ?? '', executorToken)
  ) {
    return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
  }

  // Service token (gateway) calls — accept Bearer token instead of session.
  // Gateway tools need to read/write notes, list agent-groups, etc.
  // Use constant-time comparison to prevent timing attacks (SOC2 #166)
  const gatewayToken = process.env.ORION_GATEWAY_TOKEN
  if (
    gatewayToken &&
    timingSafeCompare(req.headers.get('authorization') ?? '', `Bearer ${gatewayToken}`)
  ) {
    // Gateway can do anything except:
    // - DELETE on notes (safety — prevents gateway from wiping knowledge base)
    // - DELETE/PUT/POST on bugs (bugs are human tracking, not gateway-owned)
    // - ANY method on admin routes (gateway should not manage users/prompts/settings)
    //   SOC2: [HIGH] This includes GET — a leaked ORION_GATEWAY_TOKEN must not
    //   grant read access to /api/admin/* (user management, system config, etc.)
    const isNotesDelete    = req.method === 'DELETE' && pathname.startsWith('/api/notes')
    const isBugsMutate     = ['DELETE','PUT','POST','PATCH'].includes(req.method) && pathname.startsWith('/api/bugs')
    const isAdminAny       = pathname.startsWith('/api/admin')
    // Gateway must not create tasks (POST) — prevents a leaked token from
    // creating tasks assigned to arbitrary agents. The worker uses direct DB
    // access; only human sessions should create tasks via the API.
    const isTasksCreate    = req.method === 'POST' && pathname === '/api/tasks'
    const isTasksDelete    = req.method === 'DELETE' && pathname.startsWith('/api/tasks')
    if (isNotesDelete || isBugsMutate || isAdminAny || isTasksCreate || isTasksDelete) {
      // fall through to session auth — gateway token is not sufficient
    } else {
      return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
    }
  }

  // Legacy: Bearer token auth for specific paths — let them through, routes handle validation.
  // DELETE is never a gateway operation and must always require a session.
  if (
    req.method !== 'DELETE' &&
    BEARER_PATHS.some(p => pathname.startsWith(p)) &&
    req.headers.get('authorization')?.startsWith('Bearer ')
  ) {
    return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
  }

  // API key routes — pass through, route handler handles all auth
  if (API_KEY_PATHS.some(p => pathname.startsWith(p))) {
    return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
  }

  // sessionToken was already decoded above (before rate limit check) — reuse it.
  const token = sessionToken
  if (!token || !token.sub) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    const res = NextResponse.redirect(loginUrl)
    return addSecurityHeaders(res, nonce)
  }

  return addSecurityHeaders(nextWithNonce(req, nonce, correlationId), nonce)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
}
