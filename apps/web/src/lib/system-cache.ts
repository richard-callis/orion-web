/**
 * System cache — in-process TTL cache backed by SystemSetting.
 *
 * TTL values are read from SystemSetting and themselves cached for 60 s so
 * we don't hit the DB on every agent message. Changing a TTL in the settings
 * page + clicking "Invalidate" makes the new TTL take effect immediately in
 * the web process. The worker process picks up the new TTL on its next natural
 * cache expiry (no cross-process signalling).
 *
 * Usage:
 *   const value = await getOrFetch('my-key', 'cache.my.ttl', fetcher)
 *   invalidate('my-key')   // clear one entry
 *   invalidateAll()        // clear everything (call after changing TTL settings)
 */

import { prisma } from './db'

// ── Cache registry ─────────────────────────────────────────────────────────────
// Single source of truth for both the server cache and the settings UI.

export const CACHE_REGISTRY = [
  {
    key:            'cache.snapshot.ttl',
    label:          'Agent Snapshot',
    description:    'How long (seconds) to cache the ORION state snapshot injected into every agent prompt. Lower = more current data; higher = fewer DB queries.',
    defaultSeconds: 120,
  },
  {
    key:            'cache.environments.ttl',
    label:          'Environment Names',
    description:    'How long (seconds) to cache environment names injected into write_secret tool descriptions. Environments rarely change so this can be high.',
    defaultSeconds: 3600,
  },
] as const

export type CacheSettingKey = (typeof CACHE_REGISTRY)[number]['key']

const DEFAULT_TTL_MS: Record<string, number> = Object.fromEntries(
  CACHE_REGISTRY.map(c => [c.key, c.defaultSeconds * 1000])
)

// ── Internal state ─────────────────────────────────────────────────────────────

type Entry<T> = { value: T; expiresAt: number }

const valueCache = new Map<string, Entry<unknown>>()
const ttlCache   = new Map<string, Entry<number>>()  // cached TTL values from DB

const TTL_META_TTL_MS = 60_000  // re-read TTL settings at most once per minute

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readTtlMs(settingKey: string): Promise<number> {
  const now    = Date.now()
  const cached = ttlCache.get(settingKey)
  if (cached && cached.expiresAt > now) return cached.value

  try {
    const row  = await prisma.systemSetting.findUnique({ where: { key: settingKey } })
    const secs = row ? Number(row.value) : NaN
    const ms   = Number.isFinite(secs) && secs > 0
      ? secs * 1000
      : (DEFAULT_TTL_MS[settingKey] ?? 120_000)
    ttlCache.set(settingKey, { value: ms, expiresAt: now + TTL_META_TTL_MS })
    return ms
  } catch {
    return DEFAULT_TTL_MS[settingKey] ?? 120_000
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns the cached value for `cacheKey` if still fresh, otherwise calls
 * `fetcher`, caches the result for the TTL stored in `settingKey`, and returns it.
 */
export async function getOrFetch<T>(
  cacheKey:   string,
  settingKey: string,
  fetcher:    () => Promise<T>,
): Promise<T> {
  const now    = Date.now()
  const cached = valueCache.get(cacheKey) as Entry<T> | undefined
  if (cached && cached.expiresAt > now) return cached.value

  // Read TTL and fetch value in parallel — we need both regardless.
  const [ttlMs, value] = await Promise.all([readTtlMs(settingKey), fetcher()])
  valueCache.set(cacheKey, { value, expiresAt: now + ttlMs })
  return value
}

/** Clear a single cache entry so the next call re-fetches it. */
export function invalidate(cacheKey: string): void {
  valueCache.delete(cacheKey)
}

/**
 * Clear all cached values AND all cached TTL settings.
 * Call this after saving new TTL values so they take effect immediately.
 * Note: only clears the web-server process cache. The worker process
 * picks up new TTLs on its next natural expiry.
 */
export function invalidateAll(): void {
  valueCache.clear()
  ttlCache.clear()
}
