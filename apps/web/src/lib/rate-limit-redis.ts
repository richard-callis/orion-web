/**
 * Redis-backed sliding window rate limiter.
 * SOC2: [M-003] Replaces in-memory Map with Redis for distributed rate limiting.
 *
 * Uses a sorted set per key: timestamps as members scored by epoch_ms.
 * On each request:
 *   1. ZREMRANGEBYSCORE to evict expired entries
 *   2. ZCARD to count entries in window
 *   3. ZADD to record new request
 *   4. EXPIRE for auto-cleanup
 *
 * Configuration:
 *   REDIS_URL — Redis connection string (e.g. "redis://host:6379/0")
 *   UPSTASH_REDIS_URL — Upstash Redis URL (fallback)
 *   REDIS_SENTINEL_MASTER — Redis Sentinel master name (optional, enables Sentinel)
 *   REDIS_SENTINEL_NODES — Comma-separated Sentinel nodes (optional)
 *   REDIS_SENTINEL_PASSWORD — Sentinel password (optional)
 *   REDIS_PASSWORD — Redis password (optional)
 *   If REDIS_URL is not set or Redis is unavailable, falls back to in-memory Map.
 */

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: Date
  limit: number
}

// ─── In-memory fallback ───────────────────────────────────────────────────────

const fallbackStore = new Map<string, number[]>()

export function fallbackRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now()
  const windowStart = now - windowMs

  const existing = fallbackStore.get(key) || []
  const recent = existing.filter((t) => t > windowStart)

  const allowed = recent.length < maxRequests

  if (allowed) {
    recent.push(now)
  }

  fallbackStore.set(key, recent)

  if (recent.length % 100 === 0) {
    const cutoff = now - windowMs * 2
    for (const [k, timestamps] of fallbackStore) {
      const filtered = timestamps.filter((t) => t > cutoff)
      if (filtered.length === 0) {
        fallbackStore.delete(k)
      } else {
        fallbackStore.set(k, filtered)
      }
    }
  }

  const resetAt = new Date(recent.length > 0 ? recent[0] + windowMs : now + windowMs)
  const remaining = Math.max(0, maxRequests - recent.length)

  return { allowed, remaining, resetAt, limit: maxRequests }
}

// ─── Redis implementation ─────────────────────────────────────────────────────

let redisAvailable = false
let Redis: any = null

let redisClient: any = null
const redisUrls = [
  process.env.REDIS_URL,
  process.env.UPSTASH_REDIS_URL,
  'redis://localhost:6379/0',
]

async function initRedisClient(): Promise<boolean> {
  if (redisClient) return true

  try {
    // Lazy-load ioredis to avoid startup cost
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ioredis = await import('ioredis')
    Redis = ioredis.default || ioredis
  } catch {
    return false
  }

  try {
    // Check for Sentinel configuration
    const sentinelMaster = process.env.REDIS_SENTINEL_MASTER
    const sentinelNodes = process.env.REDIS_SENTINEL_NODES

    if (sentinelMaster && sentinelNodes) {
      // Parse Sentinel nodes: "host1:26379,host2:26379"
      const nodes = sentinelNodes.split(',').map((node) => {
        const [host, port] = node.trim().split(':')
        return { host, port: parseInt(port || '26379', 10) }
      })

      redisClient = new Redis({
        sentinels: nodes,
        name: sentinelMaster,
        db: 0,
        // Sentinel connection options
        sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
        password: process.env.REDIS_PASSWORD,
      })
    } else {
      const url = redisUrls.find((u) => u && u.trim())
      if (!url) return false
      redisClient = new Redis(url)
    }

    // Test the connection
    await redisClient.ping()
    redisAvailable = true
    return true
  } catch (error) {
    redisClient = null
    redisAvailable = false
    return false
  }
}

/**
 * Redis-backed sliding window rate limiter.
 * Falls back to in-memory if Redis is unavailable.
 *
 * @param key Unique identifier for the rate limit (e.g., "rate-limit:ip:192.168.1.1:/api/chat")
 * @param maxRequests Maximum requests allowed in the window
 * @param windowMs Time window in milliseconds
 * @returns Rate limit result with allowed status, remaining count, and reset time
 */
export async function rateLimitRedis(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!redisAvailable) {
    const ok = await initRedisClient()
    if (!ok) return fallbackRateLimit(key, maxRequests, windowMs)
  }

  if (!redisClient) return fallbackRateLimit(key, maxRequests, windowMs)

  try {
    const now = Date.now()
    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_ms = tonumber(ARGV[2])
      local max_requests = tonumber(ARGV[3])

      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

      -- Count current entries in window
      local count = redis.call('ZCARD', key)

      if count >= max_requests then
        -- Return: allowed (0), count, oldest timestamp
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local reset_ts = oldest[2] and (tonumber(oldest[2]) + window_ms) or (now + window_ms)
        return {0, count, reset_ts}
      end

      -- Add current request (unique member: score + random suffix)
      redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))

      -- Set TTL to 2x window for auto-cleanup
      redis.call('EXPIRE', key, math.ceil((window_ms * 2) / 1000))

      -- Return: allowed (1), count after increment, window reset timestamp
      return {1, count + 1, now + window_ms}
    `

    const result = await redisClient.eval(luaScript, 1, key, String(now), String(windowMs), String(maxRequests))

    if (!Array.isArray(result) || result.length < 3) {
      return fallbackRateLimit(key, maxRequests, windowMs)
    }

    const [allowed, count, resetTs] = result as [number, number, number]
    const remaining = Math.max(0, maxRequests - count)
    const resetAt = new Date(resetTs)

    return {
      allowed: allowed === 1,
      remaining,
      resetAt,
      limit: maxRequests,
    }
  } catch (error) {
    redisAvailable = false
    redisClient = null
    return fallbackRateLimit(key, maxRequests, windowMs)
  }
}

/**
 * Get Redis connection status for health checks.
 */
export async function getRedisStatus(): Promise<{
  available: boolean
  url?: string
  sentinel?: { master: string; nodes: string[] }
}> {
  if (redisAvailable) return { available: true }

  const initOk = await initRedisClient()
  if (initOk) return { available: true }

  const sentinelMaster = process.env.REDIS_SENTINEL_MASTER
  const sentinelNodes = process.env.REDIS_SENTINEL_NODES

  if (sentinelMaster && sentinelNodes) {
    return {
      available: false,
      sentinel: {
        master: sentinelMaster,
        nodes: sentinelNodes.split(',').map((n) => n.trim()),
      },
    }
  }

  return {
    available: false,
    url: redisUrls.find((u) => u && u.trim()) || undefined,
  }
}
