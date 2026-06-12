/**
 * ELK/ELK-stack poller job — runs every 15s (configurable).
 *
 * Queries the ELK cluster for new events since the last watermark.
 * Uses Logstash or Elasticsearch _search API to pull events.
 *
 * Environment variables:
 *   - ELK_URL: Base URL of Logstash HTTP input (e.g. http://elk:8080)
 *   - ELK_INDEX: Index pattern to search (e.g. 'logstash-*')
 *   - ELK_API_KEY: API key or basic auth (optional)
 *   - ELK_POLL_INTERVAL_SEC: Poll interval in seconds (default: 15)
 */

import { prisma } from '@/lib/db'
import { normalizeElkEvent, type ElkEvent } from '@/lib/security/normalize/elk'
import { normalizedEventSchema } from '@/lib/security/types'

// ── Configuration ─────────────────────────────────────────────────────────────

const ELK_URL = process.env.ELK_URL || ''
const ELK_INDEX = process.env.ELK_INDEX || 'logstash-*'
const ELK_API_KEY = process.env.ELK_API_KEY || ''
const ELK_POLL_INTERVAL_SEC = parseInt(process.env.ELK_POLL_INTERVAL_SEC || '15', 10)
const ELK_SIZE = parseInt(process.env.ELK_POLL_SIZE || '100', 10)

// ── Poller ────────────────────────────────────────────────────────────────────

/**
 * Poll ELK for new events and insert them into SecurityEvent.
 *
 * Uses SourceHealth.lastWatermark as the high-water mark for pagination.
 * Watermarks are stored as ISO timestamps in the last event's @timestamp.
 */
export async function runElkPoller(envId: string): Promise<PollResult> {
  const startTime = Date.now()
  const result: PollResult = {
    envId,
    source: 'elk',
    polledAt: new Date(),
    eventsFound: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    errors: [],
    watermark: null,
    durationMs: 0,
  }

  // 1. Get the last watermark for this source
  const sourceHealth = await prisma.sourceHealth.findUnique({
    where: { source: 'elk' },
  })

  const sinceTime = sourceHealth?.lastWatermark ?? new Date(Date.now() - 5 * 60 * 1000) // last 5 min if no watermark

  // 2. Query ELK
  let events: ElkEvent[]
  try {
    events = await queryElk(sinceTime, ELK_INDEX, ELK_SIZE)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
    result.durationMs = Date.now() - startTime
    return result
  }

  result.eventsFound = events.length

  // 3. Normalize and insert. Track the timestamp of the last *successfully
  //    inserted* event so the watermark only advances over rows we actually
  //    persisted — Zod parse failures or DB errors must NOT bump the watermark
  //    or they'd be permanently skipped on the next poll.
  let lastInsertedTimestamp: Date | null = null

  for (const raw of events) {
    try {
      const event = normalizeElkEvent(raw)
      event.environmentId = envId

      // Validate with Zod
      const parsed = normalizedEventSchema.parse(event)

      // Check idempotency
      const existing = await prisma.securityEvent.count({
        where: { dedupKey: parsed.dedupKey, source: 'elk' },
      })

      if (existing > 0) {
        result.eventsSkipped++
        continue
      }

      await prisma.securityEvent.create({
        data: {
          id: parsed.id,
          environmentId: parsed.environmentId,
          type: parsed.type,
          source: parsed.source,
          severity: parsed.severity,
          title: parsed.title,
          description: parsed.description ?? null,
          rawEvent: parsed.rawEvent as any,
          dedupKey: parsed.dedupKey,
          firstSeen: parsed.timestamp,
          lastSeen: parsed.timestamp,
        },
      })
      result.eventsInserted++
      // Advance the in-memory watermark candidate only after a successful insert.
      if (parsed.timestamp instanceof Date && (!lastInsertedTimestamp || parsed.timestamp > lastInsertedTimestamp)) {
        lastInsertedTimestamp = parsed.timestamp
      }
    } catch (err) {
      result.errors.push(`Failed to process event: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 4. Determine the watermark to persist:
  //    - If no events were inserted, leave the existing watermark untouched.
  //    - Otherwise advance to the latest successfully-inserted timestamp.
  if (lastInsertedTimestamp) {
    result.watermark = lastInsertedTimestamp.toISOString()
  }

  // 5. Update source health. Only persist a new lastWatermark when we have
  //    a successful insert this run; otherwise keep the prior value.
  const upsertData: { lastSeenAt: Date; lastWatermark?: Date } = { lastSeenAt: new Date() }
  if (lastInsertedTimestamp) {
    upsertData.lastWatermark = lastInsertedTimestamp
  }
  await prisma.sourceHealth.upsert({
    where: { source: 'elk' },
    update: upsertData,
    create: {
      environmentId: envId,
      source: 'elk',
      lastSeenAt: new Date(),
      // For first-run create: use the inserted timestamp if available;
      // otherwise fall back to `sinceTime` so we don't accidentally skip
      // the window we just polled.
      lastWatermark: lastInsertedTimestamp ?? sinceTime,
      staleAfterMs: ELK_POLL_INTERVAL_SEC * 1000 * 3, // 3x poll interval
    },
  })

  result.durationMs = Date.now() - startTime
  return result
}

/**
 * Query ELK for events since the given timestamp.
 */
async function queryElk(since: Date, index: string, size: number): Promise<ElkEvent[]> {
  if (!ELK_URL) {
    throw new Error('ELK_URL not configured')
  }

  const query = {
    query: {
      bool: {
        must: [
          { range: { '@timestamp': { gte: since.toISOString() } } },
          { match_all: {} },
        ],
      },
    },
    size,
    sort: [{ '@timestamp': { order: 'asc' } }],
  }

  const url = `${ELK_URL}/${index}/_search`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ELK_API_KEY) {
    headers['Authorization'] = `Bearer ${ELK_API_KEY}`
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`ELK query failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  const hits = data.hits?.hits ?? []

  return hits.map((h: { _source: ElkEvent }) => h._source).filter(Boolean)
}

// ── Runner for all eligible environments ──────────────────────────────────────

export async function runElkPollerAll(): Promise<PollResult[]> {
  if (!ELK_URL) return []
  const envs = await prisma.environment.findMany({
    where: { type: 'localhost', status: 'connected' },
    select: { id: true },
  })
  return Promise.all(envs.map((env) => runElkPoller(env.id)))
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PollResult {
  envId: string
  source: string
  polledAt: Date
  eventsFound: number
  eventsInserted: number
  eventsSkipped: number
  errors: string[]
  watermark: string | null
  durationMs: number
}
