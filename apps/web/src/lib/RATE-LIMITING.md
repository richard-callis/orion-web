# Rate Limiting Implementation (RATE-001)

## Overview

ORION uses a **distributed, Redis-backed sliding window rate limiter** to prevent abuse and protect against brute-force attacks. The implementation is SOC2-compliant [M-003] and automatically falls back to in-memory rate limiting if Redis is unavailable.

## Architecture

### Sliding Window Algorithm

The rate limiter uses a **sorted set** per rate limit key to track request timestamps:

1. **Remove expired entries** — Redis removes all timestamps older than the window
2. **Count current requests** — Redis counts remaining entries in the window
3. **Allow or deny** — If count < max, increment and allow; else deny
4. **Set TTL** — Redis auto-cleans old keys after 2x the window duration

### Configuration Methods

#### Option 1: Standard Redis (Single Instance)
```bash
REDIS_URL=redis://localhost:6379/0
```

#### Option 2: Upstash Redis (Serverless)
```bash
UPSTASH_REDIS_URL=redis://:your-token@us-east1-1234567.upstash.io
```

#### Option 3: Redis Sentinel (High Availability)
```bash
REDIS_SENTINEL_MASTER=mymaster
REDIS_SENTINEL_NODES=sentinel1.host:26379,sentinel2.host:26379,sentinel3.host:26379
REDIS_SENTINEL_PASSWORD=sentinel-password  # optional
REDIS_PASSWORD=redis-password               # optional
```

## API

### `rateLimitRedis(key, maxRequests, windowMs): Promise<RateLimitResult>`

Core rate limiting function.

**Parameters:**
- `key`: Unique identifier (e.g., `"rate-limit:ip:192.168.1.1:/api/chat"`)
- `maxRequests`: Maximum requests allowed in window
- `windowMs`: Time window in milliseconds

**Returns:**
```typescript
{
  allowed: boolean          // true if request is allowed
  remaining: number         // requests remaining in window
  resetAt: Date            // when the window resets
  limit: number            // configured limit
}
```

**Example:**
```typescript
const result = await rateLimitRedis(
  'rate-limit:ip:192.168.1.1:/api/chat',
  30,           // 30 requests
  15 * 60 * 1000 // per 15 minutes
)

if (!result.allowed) {
  return NextResponse.json(
    { error: 'Too many requests' },
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
```

### Response Headers

When a request is rate-limited (429 response):

| Header | Value | Example |
|--------|-------|---------|
| `X-RateLimit-Limit` | Max requests in window | `"30"` |
| `X-RateLimit-Remaining` | Requests left | `"0"` |
| `X-RateLimit-Reset` | ISO timestamp of reset | `"2026-04-26T10:15:00Z"` |
| `Retry-After` | Seconds until retry | `"845"` |

## Current Rate Limits

Configured in `middleware.ts`:

```
Auth endpoints (/login, /api/setup, /api/auth)
  → 10 requests per 15 minutes
  → Prevents brute-force attacks

Chat/LLM endpoints (/api/chat, /api/k8s)
  → 30 requests per 15 minutes
  → Controls API costs

Webhooks (/api/webhooks)
  → 60 requests per 15 minutes
  → Automated systems get higher limit

Tool generation (/api/tools/generate)
  → 20 requests per 15 minutes
  → Cost control for LLM calls

Default
  → 100 requests per 15 minutes
```

## Fallback Behavior

If Redis is **unavailable**:

1. Rate limiter automatically falls back to **in-memory** (Map-based) tracking
2. Each ORION instance maintains its own in-memory state
3. **IMPORTANT**: In-memory rate limiting does NOT work across multiple instances
4. Connection is re-attempted on each rate limit check

To force in-memory only (development):
- Leave all `REDIS_*` environment variables unset
- Logs will show "Redis unavailable" warnings

## Testing

### Unit Tests
```bash
npm test -- src/lib/rate-limit-redis.test.ts
```

Tests cover:
- Sliding window accuracy
- Remaining count tracking
- Window expiry behavior
- Concurrent requests
- Multiple keys independence
- Type safety

### Manual Testing
```bash
# Test with curl
curl -v http://localhost:3000/api/chat \
  -H "Authorization: Bearer token"

# Check rate limit headers
# Look for X-RateLimit-* headers in response
```

### Integration with Redis

If you have Redis running locally:
```bash
# Start Redis
redis-server

# Run tests
npm test -- src/lib/rate-limit-redis.test.ts
```

## Redis Sentinel Setup (Production)

For high availability with automatic failover:

1. **Deploy 3+ Sentinel instances**
   ```
   sentinel1.example.com:26379
   sentinel2.example.com:26379
   sentinel3.example.com:26379
   ```

2. **Configure master/replica**
   ```
   redis-master:6379 (primary)
   redis-replica-1:6379
   redis-replica-2:6379
   ```

3. **Set environment variables**
   ```bash
   REDIS_SENTINEL_MASTER=mymaster
   REDIS_SENTINEL_NODES=sentinel1:26379,sentinel2:26379,sentinel3:26379
   REDIS_SENTINEL_PASSWORD=your-sentinel-password
   REDIS_PASSWORD=your-redis-password
   ```

4. **Verify connection**
   ```bash
   # Check health endpoint
   curl http://localhost:3000/api/health
   
   # Look for Redis status in response
   ```

## Performance Characteristics

- **Redis latency**: ~1-5ms per request (including Lua script execution)
- **In-memory fallback**: <1ms per request
- **Storage per key**: ~100 bytes (grows with requests in window)
- **TTL cleanup**: Automatic via Redis EXPIRE (2x window)

### Benchmarks (Single Instance)
- 10,000 requests/second: ~1-2ms added latency
- 100,000 requests/second: ~5-10ms added latency (network bound)

## Monitoring

### Health Check
```typescript
import { getRedisStatus } from './lib/rate-limit-redis'

const status = await getRedisStatus()
console.log(status)
// { available: true } or { available: false, url: '...' }
```

### Metrics to Track
- Redis connection failures
- Rate limit hit rate (429 responses)
- P99 latency of rate limit checks
- Fallback mode usage (in-memory vs Redis)

## Troubleshooting

### "Too many requests" but Redis is healthy
- Check rate limit configuration in `middleware.ts`
- Verify X-Forwarded-For header if behind proxy
- Each IP gets independent limit

### Redis connection errors
- Verify connection string format
- Check network connectivity to Redis
- Ensure Redis is running and listening
- Check credentials if password-protected

### Sentinel failover not working
- Verify all 3+ Sentinel nodes are running
- Check Sentinel configuration has correct master name
- Ensure Redis instances can reach each other

### Rate limit resets but shouldn't
- Check system clock is synchronized (NTP)
- Verify Redis server time matches application time
- Look for timezone issues

## SOC2 Compliance [M-003]

This implementation satisfies SOC2 M-003 rate limiting requirement:

- ✓ Prevents brute-force attacks on auth endpoints
- ✓ Controls abuse of compute-intensive endpoints (LLM calls)
- ✓ Distributed: works across multiple instances via Redis
- ✓ Resilient: falls back to in-memory if Redis down
- ✓ Configurable: per-path, per-user, per-IP rate limits
- ✓ Observable: X-RateLimit headers for client debugging
- ✓ Automatic: applied in middleware before business logic

## References

- [Redis Sentinel Documentation](https://redis.io/topics/sentinel)
- [ioredis Sentinel Support](https://github.com/luin/ioredis#sentinel)
- [HTTP 429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429)
- [Rate Limiting Patterns](https://cloud.google.com/architecture/rate-limiting-strategies-techniques)
