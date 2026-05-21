/**
 * CrowdSec event normalizer.
 *
 * Converts CrowdSec webhook alerts into NormalizedSecurityEvent shape.
 * CrowdSec sends decisions via webhook when new bans occur.
 */

import { type NormalizedSecurityEvent } from '../types'

export interface CrowdSecAlert {
  id: string
  stream: string
  name: string
  ts: {
    sec: number
    nsec: number
    unix: number
    unix_nsec: number
  }
  payload: {
    '@type': string
    '@id': string
    scope: string  // 'Ip' | 'Login' | 'Email' | 'Domain' | 'Fqdn' | 'Uri'
    value: string
    hash?: number
    country?: string
    as_name?: string
    labels?: Record<string, string>
    severity?: string
  }
  severity: number
  events: {
    reason: string
    ts: {
      sec: number
      unix: number
    }
    payloads: Record<string, unknown>
    scenario: string
    scope: string
  }[]
}

/**
 * Normalize a CrowdSec alert into the canonical SecurityEvent shape.
 *
 * CrowdSec webhooks deliver a `stream` envelope wrapping `Alert` objects.
 */
export function normalizeCrowdSecAlert(raw: CrowdSecAlert): NormalizedSecurityEvent {
  const event = raw.events?.[0] ?? raw
  const payload = raw.payload as CrowdSecAlert['payload'] & { scenario?: string }
  const scenario = payload.scenario ?? event.scenario ?? 'unknown'

  // Build dedup key: scenario + value + source IP/host
  const dedupKey = createDedupKey('crowdsec', scenario, payload.value, raw.id)

  // Determine severity: scenarios starting with "brute" or "lockout" are high
  let severity = 30
  const lowerScenario = scenario.toLowerCase()
  if (lowerScenario.includes('brute') || lowerScenario.includes('lockout')) severity = 70
  else if (lowerScenario.includes('scan') || lowerScenario.includes('port')) severity = 50
  else if (lowerScenario.includes('malware') || lowerScenario.includes('injection')) severity = 80
  else if (lowerScenario.includes('ddos') || lowerScenario.includes('flood')) severity = 60

  return {
    id: raw.id,
    environmentId: null,
    type: 'crowdsec_block',
    source: 'crowdsec',
    severity,
    title: `${scenario}: ${payload.value} (${payload.scope})`,
    description: event.reason ?? scenario,
    rawEvent: raw as any,
    dedupKey,
    sourceName: payload.country ?? payload.as_name ?? 'crowdsec-api',
    timestamp: new Date(raw.ts.unix * 1000),
    metadata: {
      scope: payload.scope,
      hash: payload.hash,
      scenario,
      eventIds: raw.events?.map(e => e.payloads.id ?? String(e.ts.unix)) ?? [],
    },
  }
}

/**
 * Normalize a CrowdSec decision event (ban created).
 */
export function normalizeCrowdSecDecision(
  decision: Record<string, unknown>
): NormalizedSecurityEvent {
  const ip = String(decision.ip ?? decision.value ?? 'unknown')
  const scenario = String(decision.scenario ?? 'ban')
  const duration = String(decision.duration ?? '0')

  const dedupKey = createDedupKey('crowdsec_decision', scenario, ip, String(decision.id ?? ''))

  return {
    id: String(decision.id ?? `cs_${Date.now()}`),
    environmentId: null,
    type: 'crowdsec_block',
    source: 'crowdsec',
    severity: 50,
    title: `CrowdSec ban: ${ip}`,
    description: `Scenario ${scenario} triggered for ${ip} (${duration} duration)`,
    rawEvent: decision,
    dedupKey,
    sourceName: 'crowdsec-api',
    timestamp: new Date(),
    metadata: {
      scenario,
      ip,
      duration,
    },
  }
}

function createDedupKey(source: string, ...parts: string[]): string {
  const joined = parts.join(':')
  let hash = 0
  for (let i = 0; i < joined.length; i++) {
    const char = joined.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash &= hash  // Convert to 32-bit int
  }
  return `${source}_${Math.abs(hash).toString(16)}`
}
