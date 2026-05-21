/**
 * Security correlation rule engine.
 *
 * Interprets CorrelationRule.params to group SecurityEvents into Incidents.
 * Each rule defines a pattern-matching strategy.
 */

import { prisma } from '@/lib/db'
import { type NormalizedSecurityEvent } from './types'
import { type IncidentDraft } from './types'

// ── Rule types ────────────────────────────────────────────────────────────────

/**
 * Rule parameter types supported by the correlation engine.
 */
export type RuleParams =
  | { type: 'threshold'; field: string; op: 'gte' | 'lte' | 'eq'; value: number; window: number; groupBy: string[]; maxEvents?: number }
  | { type: 'pattern'; regex: string; field: string; window: number }
  | { type: 'malware'; ruleLevel: number; field: string }
  | { type: 'process'; commandPattern: string; window: number }
  | { type: 'composite'; rules: RuleParams[]; combine: 'all' | 'any'; window: number }

// ── Correlation ───────────────────────────────────────────────────────────────

/**
 * Run all enabled correlation rules against recent events.
 *
 * Returns a list of IncidentDrafts — one per rule match.
 */
export async function correlateEvents(
  envId: string,
  since: Date,
  ruleParams: RuleParams[]
): Promise<IncidentDraft[]> {
  const drafts: IncidentDraft[] = []

  for (const params of ruleParams) {
    try {
      switch (params.type) {
        case 'threshold': {
          const result = await runThresholdRule(envId, params, since)
          if (result) drafts.push(result)
          break
        }
        case 'pattern': {
          const result = await runPatternRule(envId, params, since)
          if (result) drafts.push(result)
          break
        }
        case 'malware': {
          const result = await runMalwareRule(envId, params, since)
          if (result) drafts.push(result)
          break
        }
        case 'process': {
          const result = await runProcessRule(envId, params, since)
          if (result) drafts.push(result)
          break
        }
        case 'composite': {
          const result = await runCompositeRule(envId, params, since)
          if (result) drafts.push(result)
          break
        }
      }
    } catch {
      // Rule execution failures are non-blocking
    }
  }

  return drafts
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a groupBy / field selector against a SecurityEvent row.
 *
 * Supports two forms:
 *   - "source" — a top-level column on the SecurityEvent row
 *   - "rawEvent.srcip" or "rawEvent.alert.srcip" — a dot-path into the rawEvent JSON
 *
 * Returns the string-coerced value, or `null` if the path doesn't resolve.
 *
 * Exported for unit tests; used by `runThresholdRule` to bucket events.
 */
export function extractGroupValue(event: unknown, field: string): string | null {
  if (event === null || typeof event !== 'object') return null
  const evt = event as Record<string, unknown>

  // Top-level column access (no dot)
  if (!field.includes('.')) {
    const v = evt[field]
    return v == null ? null : String(v)
  }

  // Dot-path traversal. First segment must be a top-level column.
  const parts = field.split('.')
  let cursor: unknown = evt[parts[0]]
  for (let i = 1; i < parts.length; i++) {
    if (cursor === null || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[parts[i]]
  }
  return cursor == null ? null : String(cursor)
}

// ── Threshold rule ────────────────────────────────────────────────────────────

/**
 * Threshold rule: count events matching a pattern within a time window.
 * Example: ≥5 failed logins from same IP within 5 minutes → brute-force incident.
 */
async function runThresholdRule(
  envId: string,
  params: Extract<RuleParams, { type: 'threshold' }>,
  since: Date
): Promise<IncidentDraft | null> {
  // Find the most recent incident for this rule + group to avoid duplicate incidents
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: envId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Group events by the specified fields.
  //
  // A groupBy entry may name a top-level SecurityEvent column (e.g. "source")
  // or a JSON path into the rawEvent payload using dot notation (e.g.
  // "rawEvent.srcip", "rawEvent.alert.srcip"). This is required for the
  // brute-force rule: the attacker IP lives in the raw payload, not in a
  // first-class column — grouping by "source" would bucket every CrowdSec
  // event together regardless of attacker.
  const grouped = new Map<string, typeof events>()
  for (const event of events) {
    const groupKey = params.groupBy
      .map(f => extractGroupValue(event, f) ?? 'unknown')
      .join(':')
    if (!grouped.has(groupKey)) grouped.set(groupKey, [])
    grouped.get(groupKey)!.push(event)
  }

  let bestGroup: { key: string; events: typeof events; severity: number } | null = null

  for (const [key, group] of grouped) {
    const count = group.length
    if (count < (params.value ?? 5)) continue // threshold not met

    // Calculate severity as max of group events
    const maxSeverity = Math.max(...group.map(e => e.severity))
    const severity = params.op === 'gte'
      ? Math.min(100, maxSeverity + (count - params.value) * 5)
      : maxSeverity

    if (!bestGroup || severity > bestGroup.severity) {
      bestGroup = { key, events: group, severity }
    }
  }

  if (!bestGroup) return null

  const ruleName = `threshold_${params.field}_${params.groupBy.join('+')}`

  return {
    severity: bestGroup.severity,
    rootCauseSummary: `${bestGroup.events.length} ${params.field} events in ${params.window}s window`,
    attackerKey: bestGroup.key.split(':')[0] ?? '',
    hostKey: bestGroup.key.split(':').slice(1).join(':') || undefined,
    eventIds: bestGroup.events.map(e => e.id),
    ruleName,
    environmentId: envId,
  }
}

// ── Pattern rule ──────────────────────────────────────────────────────────────

/**
 * Pattern rule: match events against a regex within a time window.
 * Example: port scan from ntopng (many ports hit from same IP).
 */
async function runPatternRule(
  envId: string,
  params: Extract<RuleParams, { type: 'pattern' }>,
  since: Date
): Promise<IncidentDraft | null> {
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: envId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  let matched: typeof events = []
  let regex: RegExp

  try {
    regex = new RegExp(params.regex)
  } catch {
    return null
  }

  for (const event of events) {
    const fieldValue = (event as Record<string, unknown>)[params.field]
    if (typeof fieldValue === 'string' && regex.test(fieldValue)) {
      matched.push(event)
    }
  }

  if (matched.length === 0) return null

  return {
    severity: 60,
    rootCauseSummary: `Pattern "${params.regex}" matched ${matched.length} events`,
    eventIds: matched.slice(0, 50).map(e => e.id), // cap at 50 events
    ruleName: `pattern_${params.regex}`,
    environmentId: envId,
  }
}

// ── Malware rule ──────────────────────────────────────────────────────────────

/**
 * Malware rule: detect Wazuh alerts with rule.level >= threshold.
 */
async function runMalwareRule(
  envId: string,
  params: Extract<RuleParams, { type: 'malware' }>,
  since: Date
): Promise<IncidentDraft | null> {
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: envId,
      createdAt: { gte: since },
      type: 'wazuh_malware',
      severity: { gte: params.ruleLevel * 10 }, // convert level to severity scale
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  if (events.length === 0) return null

  const maxSeverity = Math.max(...events.map(e => e.severity))

  const raw = events[0].rawEvent as Record<string, unknown>
  const srcip = typeof raw.srcip === 'string' ? raw.srcip : null
  const hostname = typeof raw.hostname === 'string' ? raw.hostname : null

  return {
    severity: maxSeverity,
    rootCauseSummary: `Malware detection: ${events[0].title}`,
    attackerKey: srcip,
    hostKey: hostname ?? undefined,
    eventIds: events.map(e => e.id),
    ruleName: 'malware',
    environmentId: envId,
  }
}

// ── Process rule ──────────────────────────────────────────────────────────────

/**
 * Process rule: detect suspicious process execution.
 */
async function runProcessRule(
  envId: string,
  params: Extract<RuleParams, { type: 'process' }>,
  since: Date
): Promise<IncidentDraft | null> {
  const events = await prisma.securityEvent.findMany({
    where: {
      environmentId: envId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  let matched: typeof events = []
  try {
    const regex = new RegExp(params.commandPattern)
    for (const event of events) {
      if (
        typeof (event.rawEvent as Record<string, unknown>)?.cmd === 'string' &&
        regex.test(String((event.rawEvent as Record<string, unknown>)?.cmd))
      ) {
        matched.push(event)
      }
    }
  } catch {
    return null
  }

  if (matched.length === 0) return null

  return {
    severity: 70,
    rootCauseSummary: `Suspicious process: ${params.commandPattern}`,
    eventIds: matched.slice(0, 20).map(e => e.id),
    ruleName: `process_${params.commandPattern}`,
    environmentId: envId,
  }
}

// ── Composite rule ────────────────────────────────────────────────────────────

/**
 * Composite rule: run multiple sub-rules and combine results.
 */
async function runCompositeRule(
  envId: string,
  params: Extract<RuleParams, { type: 'composite' }>,
  since: Date
): Promise<IncidentDraft | null> {
  const results: IncidentDraft[] = []

  for (const subRule of params.rules) {
    const draft = await runSingleRule(envId, subRule, since)
    if (draft) results.push(draft)
  }

  if (params.combine === 'all') {
    // Only fire if ALL sub-rules matched
    if (results.length < params.rules.length) return null
  } else {
    // 'any' — fire if ANY sub-rule matched
    if (results.length === 0) return null
  }

  // Merge event IDs and take highest severity
  const allEventIds = results.flatMap(r => r.eventIds)
  const severity = Math.max(...results.map(r => r.severity))

  return {
    severity,
    rootCauseSummary: `Composite rule matched: ${results.map(r => r.ruleName).join(', ')}`,
    eventIds: allEventIds.slice(0, 100),
    ruleName: 'composite',
    environmentId: envId,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run a single rule of any type.
 */
async function runSingleRule(
  envId: string,
  params: RuleParams,
  since: Date
): Promise<IncidentDraft | null> {
  switch (params.type) {
    case 'threshold': return runThresholdRule(envId, params, since)
    case 'pattern': return runPatternRule(envId, params, since)
    case 'malware': return runMalwareRule(envId, params, since)
    case 'process': return runProcessRule(envId, params, since)
    case 'composite': return null // handled by runCompositeRule
  }
}
