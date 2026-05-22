/**
 * Wazuh event normalizer.
 *
 * Converts Wazuh FIM, agent alerts, and rootcheck events into NormalizedSecurityEvent.
 */

import { type NormalizedSecurityEvent } from '../types'

/**
 * Agent info extracted from a Wazuh alert.
 */
interface WazuhAgent {
  id: string
  name: string
  ip: string
  registerIp?: string
  version?: string
  group?: string
  lost_at?: string | null
  type?: string
  os?: { name?: string; version?: string }
  host?: string
  lastKeepAlive?: string
  groupConfigSum?: string
  ext_version?: string
  internal_version?: number
}

/**
 * Location info from a Wazuh alert.
 */
interface WazuhLocation {
  zonedata?: string
  type?: string
  name?: string
  dstaddr?: string
  ip?: string
}

export interface WazuhAlert {
  alert?: {
    id: string
    rule: {
      id: number
      level: number
      description: string
      groups: string[]
    }
    hostname: string
    manager: string
    srcip?: string
    srcuser?: string
    dstuser?: string
    output?: string
    data?: Record<string, unknown>
    full_log?: string
    timestamp?: string
    agent?: WazuhAgent
    location?: WazuhLocation
  }
}

/**
 * Normalize a Wazuh alert into the canonical SecurityEvent shape.
 */
export function normalizeWazuhAlert(raw: WazuhAlert): NormalizedSecurityEvent {
  const alert = raw.alert
  if (!alert) {
    throw new Error('Wazuh alert payload missing "alert" field')
  }

  const rule = alert.rule
  const agent: WazuhAgent = alert.agent ?? { id: '', name: '', ip: '' }
  const groups = rule.groups ?? []

  let eventType = 'wazuh_alert'
  if (groups.includes('syscheck')) eventType = 'wazuh_fim'
  else if (groups.includes('rootcheck')) eventType = 'wazuh_rootcheck'
  else if (groups.includes('authentication')) eventType = 'wazuh_auth'
  else if (groups.includes('malware')) eventType = 'wazuh_malware'
  else if (groups.includes('web_attack')) eventType = 'wazuh_web_attack'
  else if (groups.includes('intrusion')) eventType = 'wazuh_intrusion'

  const severity = Math.min(100, rule.level * 10)
  const sourceName = alert.manager ?? agent.name ?? alert.hostname ?? 'wazuh-manager'

  const dedupSource = alert.full_log ?? alert.output ?? ''
  const dedupKey = createDedupKey('wazuh', rule.id.toString(), agent.id ?? '', dedupSource)
  const timestamp = parseWazuhTimestamp(alert.timestamp ?? '')

  return {
    id: alert.id ?? `wazuh_${Date.now()}_${rule.id}`,
    environmentId: null,
    type: eventType,
    source: 'wazuh',
    severity,
    title: rule.description,
    description: buildDescription(alert),
    rawEvent: raw as unknown as Record<string, unknown>,
    dedupKey,
    sourceName,
    timestamp,
    metadata: {
      ruleId: rule.id,
      ruleLevel: rule.level,
      groups,
      agent: {
        id: agent.id,
        name: agent.name,
        ip: agent.ip,
        version: agent.version,
      },
      srcip: alert.srcip,
      srcuser: alert.srcuser,
      dstuser: alert.dstuser,
    },
  }
}

function buildDescription(alert: NonNullable<WazuhAlert['alert']>): string {
  const parts: string[] = []
  if (alert.full_log) parts.push(alert.full_log.slice(0, 500))
  if (alert.output) parts.push(alert.output.slice(0, 500))
  if (alert.data) {
    const dataStr = JSON.stringify(alert.data).slice(0, 500)
    if (!parts.includes(dataStr)) parts.push(dataStr)
  }
  return parts.join(' | ') || alert.rule.description
}

function parseWazuhTimestamp(ts: string): Date {
  if (!ts) return new Date()
  try {
    const parsed = new Date(ts)
    if (!Number.isNaN(parsed.getTime())) return parsed
  } catch {
    // ignore
  }
  return new Date()
}

function createDedupKey(source: string, ...parts: string[]): string {
  const joined = parts.join(':')
  let hash = 0
  for (let i = 0; i < joined.length; i++) {
    const char = joined.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash &= hash
  }
  return `${source}_${Math.abs(hash).toString(16)}`
}
