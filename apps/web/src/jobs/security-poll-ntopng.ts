/**
 * ntopng poller job — runs every 30s (configurable).
 *
 * Polls the ntopng REST API for flow data and threat alerts.
 * Uses SourceHealth.lastWatermark for deduplication and watermarking.
 *
 * Environment variables:
 *   - NTOPNG_URL: Base URL of ntopng API (e.g. http://ntopng:3000)
 *   - NTOPNG_API_KEY: API key for ntopng (required)
 *   - NTOPNG_POLL_INTERVAL_SEC: Poll interval in seconds (default: 30)
 *   - NTOPNG_POLL_SIZE: Max flows per poll (default: 200)
 */

import { prisma } from '@/lib/db'
import { normalizeNtopngFlow, normalizeNtopngThreatAlert, type NtopngFlow, type NtopngThreatAlert } from '@/lib/security/normalize/ntopng'
import { normalizedEventSchema } from '@/lib/security/types'

// ── Configuration ─────────────────────────────────────────────────────────────

const NTOPNG_URL = process.env.NTOPNG_URL || ''
const NTOPNG_API_KEY = process.env.NTOPNG_API_KEY || ''
const NTOPNG_POLL_INTERVAL_SEC = parseInt(process.env.NTOPNG_POLL_INTERVAL_SEC || '30', 10)
const NTOPNG_POLL_SIZE = parseInt(process.env.NTOPNG_POLL_SIZE || '200', 10)

// ── Poller ────────────────────────────────────────────────────────────────────

/**
 * Poll ntopng for threat alerts and flows.
 */
export async function runNtopngPoller(envId: string): Promise<PollResult> {
  const startTime = Date.now()
  const result: PollResult = {
    envId,
    source: 'ntopng',
    polledAt: new Date(),
    eventsFound: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    errors: [],
    watermark: null,
    durationMs: 0,
  }

  // 1. Get the last watermark
  const sourceHealth = await prisma.sourceHealth.findUnique({
    where: { source: 'ntopng' },
  })

  const sinceTime = sourceHealth?.lastWatermark ?? new Date(Date.now() - 10 * 60 * 1000) // last 10 min

  // Track the timestamp of the last *successfully inserted* event across both
  // alert and flow loops so the watermark advances only over rows we actually
  // persisted. If everything fails, we leave the prior watermark untouched.
  let lastInsertedTimestamp: Date | null = null

  // 2. Poll threat alerts
  try {
    const alerts = await pollNtopngAlerts(sinceTime, NTOPNG_POLL_SIZE)
    result.eventsFound += alerts.length

    for (const raw of alerts) {
      try {
        const event = normalizeNtopngThreatAlert(raw)
        event.environmentId = envId

        const parsed = normalizedEventSchema.parse(event)

        const existing = await prisma.securityEvent.count({
          where: { dedupKey: parsed.dedupKey, source: 'ntopng' },
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
        if (parsed.timestamp instanceof Date && (!lastInsertedTimestamp || parsed.timestamp > lastInsertedTimestamp)) {
          lastInsertedTimestamp = parsed.timestamp
        }
      } catch (err) {
        result.errors.push(`Threat: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    result.errors.push(`Threat poll failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. Poll flows (only if source is healthy)
  if (result.eventsInserted > 0 || sourceHealth?.lastSeenAt) {
    try {
      const flows = await pollNtopngFlows(sinceTime, NTOPNG_POLL_SIZE)
      result.eventsFound += flows.length

      for (const raw of flows) {
        try {
          const event = normalizeNtopngFlow(raw)
          event.environmentId = envId

          const parsed = normalizedEventSchema.parse(event)

          // Skip low-severity normal flows for performance
          if (parsed.severity < 15 && parsed.type === 'ntopng_flow') {
            result.eventsSkipped++
            continue
          }

          const existing = await prisma.securityEvent.count({
            where: { dedupKey: parsed.dedupKey, source: 'ntopng' },
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
          if (parsed.timestamp instanceof Date && (!lastInsertedTimestamp || parsed.timestamp > lastInsertedTimestamp)) {
            lastInsertedTimestamp = parsed.timestamp
          }
        } catch (err) {
          result.errors.push(`Flow: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      result.errors.push(`Flow poll failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 4. Update source health. Only advance lastWatermark when we successfully
  //    inserted at least one event this run; otherwise leave the previous
  //    watermark untouched (avoids advancing past a failed batch).
  const now = new Date()
  const upsertData: { lastSeenAt: Date; lastWatermark?: Date } = { lastSeenAt: now }
  if (lastInsertedTimestamp) {
    upsertData.lastWatermark = lastInsertedTimestamp
    result.watermark = lastInsertedTimestamp.toISOString()
  }
  await prisma.sourceHealth.upsert({
    where: { source: 'ntopng' },
    update: upsertData,
    create: {
      environmentId: envId,
      source: 'ntopng',
      lastSeenAt: now,
      // For first-run create: use the inserted timestamp if available;
      // otherwise fall back to `sinceTime` so we don't accidentally skip
      // the window we just polled.
      lastWatermark: lastInsertedTimestamp ?? sinceTime,
      staleAfterMs: NTOPNG_POLL_INTERVAL_SEC * 1000 * 3, // 3x poll interval
    },
  })

  result.durationMs = Date.now() - startTime
  return result
}

/**
 * Poll ntopng API for threat alerts.
 */
async function pollNtopngAlerts(since: Date, limit: number): Promise<NtopngThreatAlert[]> {
  if (!NTOPNG_URL) throw new Error('NTOPNG_URL not configured')
  if (!NTOPNG_API_KEY) throw new Error('NTOPNG_API_KEY not configured')

  const res = await fetch(
    `${NTOPNG_URL}/protoapi/threat?since=${Math.round(since.getTime() / 1000)}&limit=${limit}`,
    {
      headers: {
        'Authorization': `Bearer ${NTOPNG_API_KEY}`,
      },
    }
  )

  if (!res.ok) {
    throw new Error(`ntopng threat poll failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  const threats = data.threats ?? data.alerts ?? data
  return Array.isArray(threats) ? threats : []
}

/**
 * Poll ntopng API for flow records.
 */
async function pollNtopngFlows(since: Date, limit: number): Promise<NtopngFlow[]> {
  if (!NTOPNG_URL) throw new Error('NTOPNG_URL not configured')
  if (!NTOPNG_API_KEY) throw new Error('NTOPNG_API_KEY not configured')

  // ntopng JSON API for flows
  const res = await fetch(
    `${NTOPNG_URL}/flows/json?since=${Math.round(since.getTime() / 1000)}&limit=${limit}`,
    {
      headers: {
        'Authorization': `Bearer ${NTOPNG_API_KEY}`,
      },
    }
  )

  if (!res.ok) {
    throw new Error(`ntopng flow poll failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  // ntopng returns { flows: { ... }, ... } where keys are IP pairs
  const flows = data.flows ?? {}
  return Object.values(flows) as NtopngFlow[]
}

// ── Runner for all eligible environments ──────────────────────────────────────

export async function runNtopngPollerAll(): Promise<PollResult[]> {
  if (!NTOPNG_URL) return []
  const envs = await prisma.environment.findMany({
    where: { type: 'localhost', status: 'connected' },
    select: { id: true },
  })
  return Promise.all(envs.map((env) => runNtopngPoller(env.id)))
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
