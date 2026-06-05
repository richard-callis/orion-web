/**
 * Application-layer CrowdSec bouncer.
 *
 * Queries the CrowdSec LAPI for active ban decisions and caches them in
 * Redis so middleware can check every incoming request without a synchronous
 * LAPI round-trip.
 *
 * Architecture:
 *   - Decision list is fetched from CROWDSEC_API/v1/decisions?type=ban
 *   - Each banned IP is stored in Redis under crowdsec:block:{ip} with a
 *     TTL equal to the decision's remaining duration (min 60s, max 7d).
 *   - isIpBlocked() reads from Redis (O(1)); falls back to in-memory Set
 *     if Redis is unavailable.
 *   - syncDecisions() is called by the worker every 60s. On first call
 *     it also uses stream=true to get the full list.
 *
 * Env vars:
 *   CROWDSEC_API       — LAPI base URL (e.g. http://crowdsec-lapi.crowdsec:8080)
 *   CROWDSEC_API_KEY   — Bouncer API key
 *   CROWDSEC_BLOCK_TTL — Override Redis TTL in seconds (default: decision duration)
 */

const REDIS_PREFIX = 'crowdsec:block:'
const FALLBACK_TTL = 300 // seconds; used when decision has no duration

// In-memory fallback for when Redis is unavailable.
// Keyed by IP, value = expiry timestamp (ms).
const memoryBlocklist = new Map<string, number>()

interface CrowdSecDecision {
  id: number
  origin: string
  type: string
  scope: string
  value: string       // the blocked IP or CIDR
  duration: string    // e.g. "3h59m51.33s"
  scenario?: string
  simulated?: boolean
}

function parseDurationSeconds(d: string): number {
  // Parse Go duration strings: "3h59m51.33s", "86400s", "24h0m0s"
  let total = 0
  const hours = d.match(/(\d+(?:\.\d+)?)h/)
  const mins  = d.match(/(\d+(?:\.\d+)?)m(?!s)/) // 'm' not followed by 's' (avoid 'ms')
  const secs  = d.match(/(\d+(?:\.\d+)?)s/)
  if (hours) total += parseFloat(hours[1]) * 3600
  if (mins)  total += parseFloat(mins[1]) * 60
  if (secs)  total += parseFloat(secs[1])
  return Math.max(60, Math.ceil(total)) // minimum 60s TTL
}

// ── Redis lazy client ─────────────────────────────────────────────────────────

let redisClient: any = null

async function getRedis(): Promise<any | null> {
  if (redisClient) return redisClient
  try {
    const ioredis = await import('ioredis')
    const Redis = ioredis.default || ioredis
    const sentinelMaster = process.env.REDIS_SENTINEL_MASTER
    const sentinelNodes  = process.env.REDIS_SENTINEL_NODES
    let client: any
    if (sentinelMaster && sentinelNodes) {
      const nodes = sentinelNodes.split(',').map(n => {
        const [host, port] = n.trim().split(':')
        return { host, port: parseInt(port || '26379', 10) }
      })
      client = new Redis({ sentinels: nodes, name: sentinelMaster, password: process.env.REDIS_PASSWORD })
    } else {
      const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || 'redis://localhost:6379/0'
      client = new Redis(url)
    }
    await client.ping()
    redisClient = client
    return redisClient
  } catch {
    return null
  }
}

// ── Decision sync ─────────────────────────────────────────────────────────────

let lastSyncAt = 0
const SYNC_INTERVAL_MS = 60_000

/**
 * Fetch all current ban decisions from the CrowdSec LAPI and write them
 * to Redis (and the in-memory fallback). Safe to call on every worker tick.
 * No-ops if CROWDSEC_API is not configured.
 */
export async function syncCrowdSecDecisions(): Promise<void> {
  const api = process.env.CROWDSEC_API
  const key = process.env.CROWDSEC_API_KEY
  if (!api || !key) return

  const now = Date.now()
  if (now - lastSyncAt < SYNC_INTERVAL_MS) return
  lastSyncAt = now

  let decisions: CrowdSecDecision[]
  try {
    const res = await fetch(`${api}/v1/decisions?type=ban`, {
      headers: { 'X-Api-Key': key },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.warn(`[crowdsec-bouncer] LAPI returned ${res.status} — skipping sync`)
      return
    }
    const body = await res.json()
    decisions = Array.isArray(body) ? body : []
  } catch (err) {
    console.warn(`[crowdsec-bouncer] LAPI fetch failed: ${err instanceof Error ? err.message : err}`)
    return
  }

  const redis = await getRedis()
  const overrideTtl = process.env.CROWDSEC_BLOCK_TTL ? parseInt(process.env.CROWDSEC_BLOCK_TTL, 10) : null

  for (const d of decisions) {
    if (d.type !== 'ban' || !d.value || d.simulated) continue
    const ttl = overrideTtl ?? parseDurationSeconds(d.duration ?? '')
    const ip  = d.value

    // Write to Redis
    if (redis) {
      await redis.setex(`${REDIS_PREFIX}${ip}`, ttl, '1').catch(() => {/* best-effort */})
    }

    // Write to in-memory fallback
    memoryBlocklist.set(ip, now + ttl * 1000)
  }

  // Evict expired entries from the in-memory fallback
  const cutoff = Date.now()
  for (const [ip, exp] of memoryBlocklist) {
    if (exp < cutoff) memoryBlocklist.delete(ip)
  }
}

// ── IP check ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the given IP has an active CrowdSec ban decision.
 * Checks Redis first; falls back to the in-memory cache.
 *
 * This is a pure read path — it does NOT call the LAPI on each request.
 * Sync is driven by the worker (syncCrowdSecDecisions every 60s).
 *
 * NOTE: does not check CIDR blocks, only exact IP matches. CrowdSec
 * decisions targeting ranges (scope=Range) are not checked here.
 */
export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!ip || ip === 'unknown') return false

  const redis = await getRedis()
  if (redis) {
    try {
      const hit = await redis.exists(`${REDIS_PREFIX}${ip}`)
      return hit === 1
    } catch {
      // fall through to memory
    }
  }

  const exp = memoryBlocklist.get(ip)
  if (!exp) return false
  if (exp < Date.now()) {
    memoryBlocklist.delete(ip)
    return false
  }
  return true
}
