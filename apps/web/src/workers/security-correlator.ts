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
import { correlateEvents, recordRuleIncident } from '@/lib/security/rule-engine'
import type { NamedRule, RuleParams } from '@/lib/security/rule-engine'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Select correlation rules that apply to a given environment.
 *
 * A rule applies when its `environmentId` matches the env id OR is `null`
 * (a global rule). Exported for unit tests — the matching logic guards
 * against a regression where global rules were silently excluded by a
 * Prisma include that joined via `Environment.correlationRules`.
 */
export function rulesForEnvironment<R extends { environmentId: string | null }>(
  rules: R[],
  envId: string,
): R[] {
  return rules.filter(r => r.environmentId === envId || r.environmentId === null)
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** How far back to look for uncorrelated events (seconds). */
const LOOKBACK_WINDOW_SEC = 60

/** Max incidents to create per run (guard against spam). */
const MAX_INCIDENTS_PER_RUN = 10

/** How often to update source health staleness check (ms). */
const STALENESS_CHECK_INTERVAL = 5 * 60 * 1000

/**
 * Synthetic ID used to surface the orphan-events bucket in {@link CorrelationResult}.
 *
 * Events with `environmentId === null` cannot be processed against a real
 * Environment row; the correlator handles them under this sentinel so they
 * still get matched against global rules (BLOCK-1, PR #408).
 *
 * Exported so tests can assert against the synthetic bucket result.
 */
export const GLOBAL_BUCKET_ID = '__global__'

// ── Correlator ────────────────────────────────────────────────────────────────

/**
 * Run the correlator: find uncorrelated events, run rules, create incidents.
 *
 * Returns correlation results for each environment processed.
 */
export async function runCorrelator(): Promise<CorrelationResult[]> {
  const results: CorrelationResult[] = []
  const startTime = Date.now()

  // 1. Get environments with uncorrelated security events.
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
    select: { id: true },
  })

  // 1b. Detect orphaned events (environmentId IS NULL). The previous query
  //     only matched Environment rows, so events ingested without an env
  //     binding were never correlated. We process them under a synthetic
  //     `GLOBAL_BUCKET_ID` so global rules can still run against them.
  const orphanCount = await prisma.securityEvent.count({
    where: {
      environmentId: null,
      createdAt: {
        gte: new Date(Date.now() - LOOKBACK_WINDOW_SEC * 1000),
      },
      incidentId: null,
    },
  })
  const hasOrphans = orphanCount > 0

  // 2. Fetch correlation rules in a single query that includes BOTH
  //    per-environment rules AND global rules (environmentId IS NULL).
  //    A prior implementation joined rules via Environment.correlationRules,
  //    which silently dropped global rules — meaning every default rule
  //    (brute-force, port-scan, malware, suspicious-process) was missed.
  const allRules = await prisma.correlationRule.findMany({
    where: {
      enabled: true,
    },
    select: {
      name: true,
      params: true,
      severity: true,
      environmentId: true,
    },
  })

  for (const env of environments) {
    const envRules = rulesForEnvironment(allRules, env.id)
    try {
      const envResult = await correlateEnvironment({
        id: env.id,
        correlationRules: envRules.map(r => ({
          name: r.name,
          params: r.params,
          severity: r.severity,
        })),
      })
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

  // 2b. Process the synthetic global bucket for orphan events. Only global
  //     rules apply (environmentId IS NULL) — per-environment rules cannot
  //     match events that have no environment binding.
  if (hasOrphans) {
    const globalRules = allRules.filter(r => r.environmentId === null)
    try {
      const orphanResult = await correlateEnvironment(
        {
          id: GLOBAL_BUCKET_ID,
          correlationRules: globalRules.map(r => ({
            name: r.name,
            params: r.params,
            severity: r.severity,
          })),
        },
        { isGlobalBucket: true },
      )
      results.push(orphanResult)
    } catch {
      results.push({
        envId: GLOBAL_BUCKET_ID,
        status: 'error',
        error: 'Global bucket correlation failed',
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
 *
 * When `opts.isGlobalBucket` is true, `env.id` is the {@link GLOBAL_BUCKET_ID}
 * sentinel and the query targets events with `environmentId IS NULL` instead.
 * The correlator never persists `GLOBAL_BUCKET_ID` as an Environment FK; on
 * the global path, generated Incidents are written with `environmentId: null`.
 */
async function correlateEnvironment(
  env: {
    id: string
    correlationRules: Array<{ name: string; params: unknown; severity: number }>
  },
  opts: { isGlobalBucket?: boolean } = {},
): Promise<CorrelationResult> {
  const envStartTime = Date.now()
  const isGlobal = opts.isGlobalBucket === true

  // 1. Fetch uncorrelated events since lookback window. Global bucket queries
  //    use `environmentId: null` so orphan events are processed exactly once.
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: isGlobal ? null : env.id,
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

  // 2. Convert rule params from JSON to typed RuleParams, preserving
  //    the rule name so the engine can log per-rule errors (MAJOR-4)
  //    and attribute incidents to the correct rule.
  const namedRules: NamedRule[] = env.correlationRules.map(r => ({
    name: r.name,
    params: r.params as RuleParams,
  }))

  // 3. Run correlation.
  //    For the global bucket, the rule engine receives the synthetic ID
  //    (used solely for its rate-limit bucket keys); generated drafts will
  //    be rewritten to `environmentId: null` below.
  const { drafts, errorCount, erroredRules } = await correlateEvents(
    env.id,
    new Date(Date.now() - LOOKBACK_WINDOW_SEC * 1000),
    namedRules,
  )

  if (errorCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[siem] correlator env=${env.id}: ${errorCount} rule(s) failed: ${erroredRules.join(', ')}`,
    )
  }

  // 4. Deduplicate: keep in-run drafts unique by `${attackerKey}:${ruleName}`
  //    so a port-scan draft is not silently dropped by a brute-force draft on
  //    the same IP. The previous implementation keyed the from-DB set by
  //    `attackerKey` alone but used the 2-tuple for the in-run add/check,
  //    causing any open incident on the same IP to suppress every new rule
  //    against that IP (BLOCK-1, PR #408).
  //
  //    The Incident model does not currently store a rule name, so we cannot
  //    safely 2-tuple the DB set. We still preload open incidents to suppress
  //    multiple in-run drafts that all target an attacker for which any
  //    incident is already open under the same rule — by checking the
  //    in-run set only. Cross-run protection is provided by the per-rule
  //    rate limit (`recordRuleIncident` / `shouldRateLimitRule`).
  const existingKeys = new Set<string>()
  const newDrafts = drafts.filter(d => {
    const ruleKey = `${d.attackerKey ?? 'unknown'}:${d.ruleName ?? 'unknown'}`
    if (existingKeys.has(ruleKey)) return false
    existingKeys.add(ruleKey)
    return true
  })

  // 5. Cap incidents created per run
  const cappedDrafts = newDrafts.slice(0, MAX_INCIDENTS_PER_RUN)

  // 6. Create incidents. Drafts produced from the global bucket must be
  //    written with `environmentId: null` (the synthetic bucket ID is never
  //    a valid FK target).
  let incidentsCreated = 0
  for (const draft of cappedDrafts) {
    try {
      const incidentEnvId = isGlobal ? null : draft.environmentId
      const incident = await prisma.incident.create({
        data: {
          environmentId: incidentEnvId,
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

      // R4 / MAJOR-2 — feed the per-rule rate-limit bucket so a runaway
      // rule is capped on subsequent runs. The cap is enforced inside
      // `correlateEvents` before the rule runs again.
      if (draft.ruleName) recordRuleIncident(env.id, draft.ruleName)

      incidentsCreated++
    } catch (err) {
      // MAJOR-4 mirror: log so a misbehaving DB or constraint violation
      // is visible. Previously this was a silent catch, which made
      // dropped incidents undetectable.
      // eslint-disable-next-line no-console
      console.error(
        `[siem] correlator env=${env.id}: failed to create incident for rule "${draft.ruleName ?? 'unknown'}":`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      )
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
