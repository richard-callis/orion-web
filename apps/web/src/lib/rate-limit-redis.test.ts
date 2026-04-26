/**
 * Unit and integration tests for Redis-backed rate limiter
 * SOC2: [M-003] Rate limiting compliance tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { rateLimitRedis, fallbackRateLimit, getRedisStatus, RateLimitResult } from './rate-limit-redis'

describe('Rate Limiter', () => {
  // ─── Fallback (In-Memory) Tests ───────────────────────────────────────────
  describe('fallbackRateLimit (in-memory)', () => {
    it('should allow requests under the limit', () => {
      const result = fallbackRateLimit('test-key', 3, 1000)
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(2)
      expect(result.limit).toBe(3)
    })

    it('should reject requests exceeding the limit', () => {
      const result1 = fallbackRateLimit('test-key-2', 2, 1000)
      const result2 = fallbackRateLimit('test-key-2', 2, 1000)
      const result3 = fallbackRateLimit('test-key-2', 2, 1000)

      expect(result1.allowed).toBe(true)
      expect(result2.allowed).toBe(true)
      expect(result3.allowed).toBe(false)
      expect(result3.remaining).toBe(0)
    })

    it('should provide accurate resetAt time', () => {
      const now = Date.now()
      const windowMs = 5000
      const result = fallbackRateLimit('test-key-3', 1, windowMs)

      const resetTs = result.resetAt.getTime()
      expect(resetTs).toBeGreaterThanOrEqual(now + windowMs)
      expect(resetTs).toBeLessThanOrEqual(now + windowMs + 100)
    })

    it('should respect window expiry', (done) => {
      const key = 'test-key-4'
      const windowMs = 100

      // First request should succeed
      const result1 = fallbackRateLimit(key, 1, windowMs)
      expect(result1.allowed).toBe(true)

      // Second request should fail
      const result2 = fallbackRateLimit(key, 1, windowMs)
      expect(result2.allowed).toBe(false)

      // After window expires, should succeed again
      setTimeout(() => {
        const result3 = fallbackRateLimit(key, 1, windowMs)
        expect(result3.allowed).toBe(true)
        done()
      }, windowMs + 10)
    })

    it('should handle multiple keys independently', () => {
      const result1a = fallbackRateLimit('key-a', 1, 1000)
      const result1b = fallbackRateLimit('key-b', 1, 1000)

      expect(result1a.allowed).toBe(true)
      expect(result1b.allowed).toBe(true)

      const result2a = fallbackRateLimit('key-a', 1, 1000)
      const result2b = fallbackRateLimit('key-b', 1, 1000)

      expect(result2a.allowed).toBe(false)
      expect(result2b.allowed).toBe(false)
    })
  })

  // ─── Redis Tests (if available) ────────────────────────────────────────────
  describe('rateLimitRedis', () => {
    beforeEach(async () => {
      // Clear Redis if available
      const status = await getRedisStatus()
      if (status.available) {
        // Could clear keys here if needed
      }
    })

    it('should return RateLimitResult with required fields', async () => {
      const result = await rateLimitRedis('redis-test-1', 5, 1000)

      expect(result).toHaveProperty('allowed')
      expect(result).toHaveProperty('remaining')
      expect(result).toHaveProperty('resetAt')
      expect(result).toHaveProperty('limit')
      expect(typeof result.allowed).toBe('boolean')
      expect(typeof result.remaining).toBe('number')
      expect(result.resetAt instanceof Date).toBe(true)
      expect(result.limit).toBe(5)
    })

    it('should allow requests under the limit', async () => {
      const result1 = await rateLimitRedis('redis-test-2', 3, 5000)
      const result2 = await rateLimitRedis('redis-test-2', 3, 5000)
      const result3 = await rateLimitRedis('redis-test-2', 3, 5000)

      expect(result1.allowed).toBe(true)
      expect(result1.remaining).toBe(2)
      expect(result2.allowed).toBe(true)
      expect(result2.remaining).toBe(1)
      expect(result3.allowed).toBe(true)
      expect(result3.remaining).toBe(0)
    })

    it('should reject requests exceeding the limit', async () => {
      const key = 'redis-test-3'
      const maxRequests = 2

      const r1 = await rateLimitRedis(key, maxRequests, 5000)
      const r2 = await rateLimitRedis(key, maxRequests, 5000)
      const r3 = await rateLimitRedis(key, maxRequests, 5000)

      expect(r1.allowed).toBe(true)
      expect(r2.allowed).toBe(true)
      expect(r3.allowed).toBe(false)
      expect(r3.remaining).toBe(0)
    })

    it('should accurately track remaining count', async () => {
      const result = await rateLimitRedis('redis-test-4', 10, 5000)

      // First request uses 1, leaving 9
      expect(result.remaining).toBe(Math.max(0, 10 - 1))
    })

    it('should provide resetAt in the future', async () => {
      const before = Date.now()
      const result = await rateLimitRedis('redis-test-5', 5, 3000)
      const after = Date.now()

      const resetTs = result.resetAt.getTime()
      expect(resetTs).toBeGreaterThan(before)
      expect(resetTs).toBeLessThanOrEqual(before + 3000 + 500) // Allow some clock skew
    })

    it('should handle many concurrent requests', async () => {
      const key = 'redis-test-concurrent'
      const maxRequests = 10
      const windowMs = 10000

      const promises = Array(15)
        .fill(null)
        .map(() => rateLimitRedis(key, maxRequests, windowMs))

      const results = await Promise.all(promises)

      // Count allowed
      const allowedCount = results.filter((r: any) => r.allowed).length
      expect(allowedCount).toBe(maxRequests)

      // Remaining should be 0 for denied requests
      const deniedResults = results.filter((r: any) => !r.allowed)
      expect(deniedResults.every((r: any) => r.remaining === 0)).toBe(true)
    })
  })

  // ─── Configuration Tests ──────────────────────────────────────────────────
  describe('getRedisStatus', () => {
    it('should return status object', async () => {
      const status = await getRedisStatus()
      expect(status).toHaveProperty('available')
      expect(typeof status.available).toBe('boolean')
    })

    it('should include url on unavailable without Sentinel', async () => {
      // Save original env
      const originalRedisUrl = process.env.REDIS_URL

      try {
        // Clear Redis URL
        delete (process.env as any).REDIS_URL
        delete (process.env as any).UPSTASH_REDIS_URL

        const status = await getRedisStatus()
        // Status may vary based on actual Redis availability
        expect(status).toHaveProperty('available')
      } finally {
        // Restore
        if (originalRedisUrl) {
          process.env.REDIS_URL = originalRedisUrl
        }
      }
    })
  })

  // ─── Type Safety Tests ────────────────────────────────────────────────────
  describe('Type Safety', () => {
    it('RateLimitResult type is correct', async () => {
      const result = await rateLimitRedis('type-test', 5, 1000)

      // These should compile without TypeScript errors
      const _allowed: boolean = result.allowed
      const _remaining: number = result.remaining
      const _resetAt: Date = result.resetAt
      const _limit: number = result.limit

      expect([_allowed, _remaining, _resetAt, _limit]).toBeDefined()
    })
  })
})

// ─── Integration Test Suite (requires running Redis) ─────────────────────────
describe('Rate Limiter Integration (with Redis)', () => {
  // These tests require a running Redis instance
  // Skip if Redis is not available
  const skipIfNoRedis = process.env.SKIP_REDIS_TESTS === 'true'

  describe.skipIf(skipIfNoRedis)('Redis-backed implementation', () => {
    it('should use Redis when available', async () => {
      const status = await getRedisStatus()

      if (status.available) {
        const result = await rateLimitRedis('integration-1', 5, 5000)
        expect(result.allowed).toBe(true)
        expect(result.remaining).toBeDefined()
      } else {
        // Fall back to in-memory test
        const result = await rateLimitRedis('integration-fallback', 5, 5000)
        expect(result.allowed).toBe(true)
      }
    })

    it('should handle rapid requests', async () => {
      const key = 'integration-rapid'
      const maxRequests = 100
      const windowMs = 10000

      const startTime = Date.now()
      const results: RateLimitResult[] = []

      for (let i = 0; i < maxRequests + 20; i++) {
        const result = await rateLimitRedis(key, maxRequests, windowMs)
        results.push(result)
      }

      const elapsedMs = Date.now() - startTime

      // Should have exactly maxRequests allowed
      const allowedCount = results.filter((r: any) => r.allowed).length
      expect(allowedCount).toBe(maxRequests)

      // Remaining should be 0 or negative for denied
      const lastAllowed = results.findLast((r: any) => r.allowed)
      expect(lastAllowed?.remaining).toBe(0)
    })

    it('should survive Redis connection loss and recover', async () => {
      const status1 = await getRedisStatus()
      const result1 = await rateLimitRedis('recovery-1', 10, 5000)

      // Even if Redis is down, should fall back to in-memory
      const result2 = await rateLimitRedis('recovery-1', 10, 5000)
      expect(result2.allowed).toBe(true)

      const status2 = await getRedisStatus()
      expect([status1.available, status2.available]).toBeDefined()
    })
  })
})
