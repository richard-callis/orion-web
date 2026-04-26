/**
 * Rate Limiting Examples and Use Cases
 * SOC2: [M-003] Demonstrates proper rate limiting integration
 */

import { rateLimitRedis, RateLimitResult } from './rate-limit-redis'
import { NextRequest, NextResponse } from 'next/server'

// ─── Example 1: IP-Based Rate Limiting ───────────────────────────────────────
/**
 * Prevent brute-force attacks on login endpoint
 */
export async function exampleIPBasedRateLimit(
  clientIp: string,
  endpoint: string,
): Promise<RateLimitResult> {
  const key = `rate-limit:ip:${clientIp}:${endpoint}`
  return rateLimitRedis(
    key,
    10, // 10 attempts
    15 * 60 * 1000 // per 15 minutes
  )
}

// ─── Example 2: User-Based Rate Limiting ──────────────────────────────────────
/**
 * Control API usage per authenticated user
 * Prevents single user from consuming all resources
 */
export async function exampleUserBasedRateLimit(
  userId: string,
  endpoint: string,
): Promise<RateLimitResult> {
  const key = `rate-limit:user:${userId}:${endpoint}`
  return rateLimitRedis(
    key,
    100, // 100 requests
    60 * 60 * 1000 // per hour
  )
}

// ─── Example 3: API Key Rate Limiting ──────────────────────────────────────────
/**
 * Apply per-key quotas for API access
 * Different keys may have different limits
 */
export async function exampleApiKeyRateLimit(
  apiKey: string,
  tier: 'free' | 'pro' | 'enterprise',
): Promise<RateLimitResult> {
  const limits = {
    free: [100, 60 * 60 * 1000], // 100/hour
    pro: [10000, 60 * 60 * 1000], // 10k/hour
    enterprise: [100000, 60 * 60 * 1000], // 100k/hour
  }

  const [maxRequests, windowMs] = limits[tier]
  const key = `rate-limit:api-key:${apiKey}`

  return rateLimitRedis(key, maxRequests, windowMs)
}

// ─── Example 4: Multi-Scope Rate Limiting ──────────────────────────────────────
/**
 * Apply multiple rate limits to a single request
 * (IP, user, and API tier limits)
 */
export async function exampleMultiScopeRateLimit(
  clientIp: string,
  userId: string | null,
  apiKey: string | null,
  endpoint: string,
  tier: 'free' | 'pro' | 'enterprise' = 'free',
): Promise<{ allowed: boolean; details: Record<string, RateLimitResult> }> {
  const checks: Record<string, Promise<RateLimitResult>> = {}

  // Always check IP limit (prevents distributed brute-force)
  checks.ip = exampleIPBasedRateLimit(clientIp, endpoint)

  // If authenticated, also check user limit
  if (userId) {
    checks.user = exampleUserBasedRateLimit(userId, endpoint)
  }

  // If using API key, also check API tier limit
  if (apiKey) {
    checks.apiKey = exampleApiKeyRateLimit(apiKey, tier)
  }

  const results = await Promise.all(Object.values(checks))
  const details: Record<string, RateLimitResult> = {}

  let index = 0
  for (const key of Object.keys(checks)) {
    details[key] = results[index++]
  }

  // ALL limits must pass
  const allowed = Object.values(details).every((r) => r.allowed)

  return { allowed, details }
}

// ─── Example 5: Middleware Integration ────────────────────────────────────────
/**
 * Complete middleware example using rate limiting
 */
export async function exampleMiddlewareWithRateLimit(req: NextRequest) {
  const clientIp = getClientIp(req)
  const { pathname } = req.nextUrl

  // Check rate limit
  const result = await exampleIPBasedRateLimit(clientIp, pathname)

  if (!result.allowed) {
    return NextResponse.json(
      {
        error: 'Too many requests',
        retryAfter: Math.ceil(
          (result.resetAt.getTime() - Date.now()) / 1000
        ),
      },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': String(result.remaining),
          'X-RateLimit-Reset': result.resetAt.toISOString(),
          'Retry-After': String(
            Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)
          ),
        },
      }
    )
  }

  return NextResponse.next()
}

// ─── Example 6: Response Wrapper with Rate Limit Headers ─────────────────────
/**
 * Helper to attach rate limit info to successful responses
 */
export function exampleAddRateLimitHeaders(
  response: NextResponse,
  result: RateLimitResult,
): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(result.limit))
  response.headers.set('X-RateLimit-Remaining', String(result.remaining))
  response.headers.set('X-RateLimit-Reset', result.resetAt.toISOString())

  return response
}

// ─── Example 7: Adaptive Rate Limiting ────────────────────────────────────────
/**
 * Adjust limits based on current system load
 * (could check server metrics, queue depth, etc.)
 */
export async function exampleAdaptiveRateLimit(
  clientIp: string,
  endpoint: string,
  systemLoad: number, // 0.0 to 1.0
): Promise<RateLimitResult> {
  // Adjust limits based on load
  let maxRequests = 30
  let windowMs = 15 * 60 * 1000

  if (systemLoad > 0.8) {
    // Heavy load: reduce to 10 requests
    maxRequests = 10
  } else if (systemLoad > 0.5) {
    // Moderate load: reduce to 20 requests
    maxRequests = 20
  }

  const key = `rate-limit:ip:${clientIp}:${endpoint}`
  return rateLimitRedis(key, maxRequests, windowMs)
}

// ─── Example 8: Rate Limit State Inspection ───────────────────────────────────
/**
 * Helper to understand rate limit state without consuming a request
 */
export async function exampleInspectRateLimit(
  clientIp: string,
  endpoint: string,
): Promise<{
  current: RateLimitResult
  timeUntilReset: number // milliseconds
  percentageUsed: number // 0-100
}> {
  const result = await exampleIPBasedRateLimit(clientIp, endpoint)

  const timeUntilReset = Math.max(0, result.resetAt.getTime() - Date.now())
  const percentageUsed = ((result.limit - result.remaining) / result.limit) * 100

  return {
    current: result,
    timeUntilReset,
    percentageUsed,
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────────

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

// ─── Usage Patterns ─────────────────────────────────────────────────────────────
/**
 * PATTERN 1: Strict Auth Endpoint Protection
 *   - Use IP-based rate limiting
 *   - Low limits (10/15min) to prevent brute-force
 *   - Example: /login, /api/auth
 */

/**
 * PATTERN 2: User API Quota
 *   - Use user-based rate limiting
 *   - Higher limits for authenticated users
 *   - Example: /api/chat, /api/tools/generate
 */

/**
 * PATTERN 3: Public API with Tiers
 *   - Use API key rate limiting with tiers
 *   - Combine with IP limits for DDoS protection
 *   - Example: /api/webhooks, external integrations
 */

/**
 * PATTERN 4: Adaptive Pricing/Load-Based
 *   - Reduce limits during high load
 *   - Increase limits during low load
 *   - Example: /api/chat, compute-intensive endpoints
 */

/**
 * PATTERN 5: Multi-Scope Defense
 *   - Apply multiple limits simultaneously
 *   - Requires ALL limits to pass
 *   - Example: /api/admin endpoints, critical operations
 */
