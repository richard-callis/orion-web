/**
 * Security event correlator worker.
 *
 * Consumes new SecurityEvent rows, runs correlation rules, and
 * upserts Incidents. Designed to be called by the worker process
 * or triggered by Postgres NOTIFY.
 *
 * This worker is the bridge between raw events and actionable incidents.
 * It runs periodically (every ~10s) via the worker poll loop.
 */

import { prisma } from '@/lib/db'
import { type IncidentDraft } from '@/lib/security/types'
import { correlateEvents } from '@/lib/security/rule-engine'
import type { RuleParams } from '@/lib/security/rule-engine'
import { getSystemRoomId } from '@/lib/seed-system-epic'

// ── Configuration ─────────────────────────────────────────────────────────────

/** How far back to look for uncorrelated events (seconds). */
const LOOKBACK_WINDOW_SEC = 60

/** Max incidents to create per run (guard against spam). */
const MAX_INCIDENTS_PER_RUN = 10

/** How often to update source health staleness check (ms). */
const STALENESS_CHECK_INTERVAL = 5 * 60 * 1000

// ── Correlator ────────────────────────────────────────────────────────────────

/**
 * Run the correlator: find uncorrelated events, run rules, create incidents.
 *
 * Returns correlation results for each environment processed.
 */
export async function runCorrelator(): Promise<CorrelationResult[]> {
  const results: CorrelationResult[] = []
  const startTime = Date.now()

  // 1. Get environments with security events
  const environments = await prisma.environment.findMany({
    where: {
      securityEvents: {
        some: {
          createdAt: {
            gte: new Date(Date.now() - LOOKBACK_WINDOW_SEC * 1000),
          },
          incidentId: null, // only uncorrelated events
        },
      },
    },
    include: {
      correlationRules: {
        where: {
          enabled: true,
        },
        select: {
          name: true,
          params: true,
          severity: true,
        },
      },
    },
  })

  for (const env of environments) {
    try {
      const envResult = await correlateEnvironment(env)
      results.push(envResult)
    } catch {
      results.push({
        envId: env.id,
        status: 'error',
        error: 'Correlation failed',
        durationMs: Date.now() - startTime,
        incidentsCreated: 0,
        eventsProcessed: 0,
      })
    }
  }

  // 2. Check for stale sources
  await checkSourceStaleness()

  return results
}

/**
 * Correlate events for a single environment.
 */
async function correlateEnvironment(
  env: {
    id: string
    correlationRules: Array<{ name: string; params: unknown; severity: number }>
  }
): Promise<CorrelationResult> {
  const envStartTime = Date.now()

  // 1. Fetch uncorrelated events since lookback window
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: env.id,
      createdAt: {
        gte: new Date(Date.now() - LOOKBACK_WINDOW_SEC * 1000),
      },
      incidentId: null,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (events.length === 0) {
    return {
      envId: env.id,
      status: 'idle',
      eventsProcessed: 0,
      incidentsCreated: 0,
      durationMs: Date.now() - envStartTime,
    }
  }

  // 2. Convert rule params from JSON to typed RuleParams
  const typedRules: RuleParams[] = env.correlationRules.map(r => r.params as RuleParams)

  // 3. Run correlation
  const drafts = await correlateEvents(
    env.id,
    new Date(Date.now() - LOOKBACK_WINDOW_SEC * 1000),
    typedRules
  )

  // 4. Deduplicate: skip drafts that would create duplicates of open incidents
  const openIncidents = await prisma.incident.findMany({
    where: {
      environmentId: env.id,
      status: { in: ['open', 'triaged', 'contained'] },
    },
    select: { id: true, attackerKey: true },
  })

  const existingKeys = new Set<string>(openIncidents.map(inc => `${inc.attackerKey ?? 'unknown'}`))
  const newDrafts = drafts.filter(d => {
    const key = `${d.attackerKey ?? 'unknown'}:${d.ruleName}`
    if (existingKeys.has(d.attackerKey ?? 'unknown')) return false
    existingKeys.add(key)
    return true
  })

  // 5. Cap incidents created per run
  const cappedDrafts = newDrafts.slice(0, MAX_INCIDENTS_PER_RUN)

  // 6. Create incidents
  let incidentsCreated = 0
  for (const draft of cappedDrafts) {
    try {
      const incident = await prisma.incident.create({
        data: {
          environmentId: draft.environmentId,
          severity: draft.severity,
          rootCauseSummary: draft.rootCauseSummary ?? null,
          attackerKey: draft.attackerKey ?? null,
          hostKey: draft.hostKey ?? null,
          status: 'open',
          openedAt: new Date(),
          events: {
            connect: draft.eventIds.slice(0, 50).map(id => ({ id })),
          },
        },
      })

      // Notify Warden in the security room
      const securityRoomId = await getSystemRoomId('system.room.security')
      if (securityRoomId) {
        await prisma.chatMessage.create({
          data: {
            roomId: securityRoomId,
            senderType: 'system',
            content: [
              `Warden | New Incident [${new Date().toISOString()}]`,
              `Incident: ${incident.rootCauseSummary || 'Untitled'}`,
              `incident.id: ${incident.id}`,
              `Severity: ${incident.severity}`,
              `Attacker: ${incident.attackerKey || 'unknown'}`,
              `Events linked: ${draft.eventIds.length}`,
              `Warden is triaging...`,
            ].join('\n'),
          },
        })
      }

      // Update events to reference the new incident
      await prisma.securityEvent.updateMany({
        where: {
          id: { in: draft.eventIds.slice(0, 50) },
          incidentId: null,
        },
        data: {
          incidentId: incident.id,
          lastSeen: new Date(),
        },
      })

      incidentsCreated++
    } catch {
      // Non-blocking — individual incident creation failures
    }
  }

  return {
    envId: env.id,
    status: incidentsCreated > 0 ? 'correlated' : 'clean',
    eventsProcessed: events.length,
    incidentsCreated,
    durationMs: Date.now() - envStartTime,
  }
}

// ── Staleness check ───────────────────────────────────────────────────────────

/**
 * Check for stale sources and emit synthetic source_stale events.
 */
async function checkSourceStaleness(): Promise<void> {
  const sources = await prisma.sourceHealth.findMany({
    where: {
      lastSeenAt: {
        not: null,
      },
    },
  })

  const now = Date.now()

  for (const source of sources) {
    if (!source.lastSeenAt) continue

    const elapsed = now - source.lastSeenAt.getTime()
    if (elapsed > source.staleAfterMs * 2) {
      // Source is stale — emit synthetic event
      await prisma.securityEvent.create({
        data: {
          id: `stale_${source.source}_${Date.now()}`,
          source: source.source,
          type: 'source_stale',
          severity: 10,
          title: `Source ${source.source} is stale (${Math.round(elapsed / 60000)}m since last event)`,
          description: `Source last seen ${elapsed}ms ago (threshold: ${source.staleAfterMs}ms)`,
          rawEvent: { staleAfterMs: source.staleAfterMs, lastSeenAt: source.lastSeenAt },
          dedupKey: `stale_${source.source}_${Math.round(now / 300000)}`, // per-5min dedup
          environmentId: source.environmentId,
        },
      })

      // Update source health
      await prisma.sourceHealth.update({
        where: { source: source.source },
        data: { lastSeenAt: new Date() }, // reset to prevent spam
      })
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CorrelationResult {
  envId: string
  status: 'correlated' | 'clean' | 'idle' | 'error'
  eventsProcessed: number
  incidentsCreated: number
  error?: string
  durationMs: number
}
