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
 *   If REDIS_URL is not set or Redis is unavailable, falls back to in-memory Map.
 */

// ─── In-memory fallback ───────────────────────────────────────────────────────

const fallbackStore = new Map<string, number[]>()

export function fallbackRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now()
  const windowStart = now - windowMs

  const existing = fallbackStore.get(key) || []
  const recent = existing.filter((t) => t > windowStart)

  if (recent.length >= maxRequests) return false

  recent.push(now)
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

  return true
}

// ─── Redis implementation ─────────────────────────────────────────────────────

let redisAvailable = false
let Redis: new (url: string) => {
  connect(): Promise<void>
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
  quit(): Promise<void>
} | null = null

let redisClient: InstanceType<typeof Redis> | null = null
const redisUrls = [
  process.env.REDIS_URL,
  process.env.UPSTASH_REDIS_URL,
  'redis://localhost:6379/0',
]

async function initRedisClient(): Promise<boolean> {
  if (redisClient || !Redis) return false

  try {
    // Lazy-load ioredis to avoid startup cost
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ioredis = await import('ioredis')
    Redis = ioredis.default || ioredis
  } catch {
    return false
  }

  const url = redisUrls.find((u) => u && u.trim())
  if (!url) return false

  try {
    redisClient = new Redis(url)
    await redisClient.connect()
    redisAvailable = true
    return true
  } catch {
    redisClient = null
    redisAvailable = false
    return false
  }
}

/**
 * Redis-backed sliding window rate limiter.
 * Falls back to in-memory if Redis is unavailable.
 */
export async function rateLimitRedis(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
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
        return 0
      end

      -- Add current request (unique member: score + random suffix)
      redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))

      -- Set TTL to 2x window for auto-cleanup
      redis.call('EXPIRE', key, math.ceil((window_ms * 2) / 1000))

      return 1
    `

    const result = await redisClient.eval(luaScript, 1, key, String(now), String(windowMs), String(maxRequests))
    return (result as number) === 1
  } catch {
    redisAvailable = false
    redisClient = null
    return fallbackRateLimit(key, maxRequests, windowMs)
  }
}

/**
 * Get Redis connection status for health checks.
 */
export async function getRedisStatus(): Promise<{ available: boolean; url?: string }> {
  if (redisAvailable) return { available: true }

  const initOk = await initRedisClient()
  if (initOk) return { available: true }

  return {
    available: false,
    url: redisUrls.find((u) => u && u.trim()) || undefined,
  }
}
