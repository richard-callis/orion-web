/**
 * ELK/ELK-stack (Elasticsearch Logstash Kibana) event normalizer.
 *
 * Handles both syslog alerts and anomaly detection events from ELK stack.
 * ELK sends events via Logstash TCP/UDP or HTTP, typically as JSON.
 */

import { type NormalizedSecurityEvent } from '../types'

/**
 * A single event from ELK. Can be a syslog event, anomaly score,
 * or any other event that Logstash forwards.
 */
export interface ElkEvent {
  // Logstash metadata
  '@timestamp'?: string
  '@version'?: string
  host?: string | object
  agent?: {
    type?: string
    version?: string
    id?: string
  }

  // Syslog fields
  syslog_timestamp?: string
  syslog_hostname?: string
  syslog_program?: string
  syslog_severity?: string | number
  syslog_message?: string
  message?: string
  loglevel?: string | number
  facility?: string

  // Anomaly detection fields
  anomaly_score?: number
  anomaly_bucket?: string
  field_name?: string
  expected_value?: number | string
  observed_value?: number | string

  // Network/event context
  source_ip?: string
  dest_ip?: string
  src_ip?: string
  dst_ip?: string
  event_type?: string
  action?: string
  user?: string
  dest_user?: string
  dest_host?: string
  url?: string
  domain?: string
  file?: string
  hash?: string
  tags?: string[]
  ecs_version?: string
}

/**
 * Normalize an ELK event into the canonical SecurityEvent shape.
 *
 * Events are classified by their anomaly_score field or event_type/tags.
 */
export function normalizeElkEvent(raw: ElkEvent): NormalizedSecurityEvent {
  const message = raw.message ?? raw.syslog_message ?? ''

  // Determine event type and severity based on available fields
  let eventType = 'anomaly'
  let severity = 30

  if (raw.anomaly_score != null) {
    severity = Math.min(100, Math.max(0, Math.round(raw.anomaly_score * 100)))
    eventType = 'anomaly'

    if (raw.anomaly_score > 0.9) {
      severity = Math.min(100, severity + 30)
    } else if (raw.anomaly_score < 0.3) {
      severity = Math.max(0, severity - 20)
    }
  } else if (raw.event_type === 'login' || raw.event_type === 'authentication') {
    eventType = 'auth_event'
    severity = raw.loglevel === 'ERROR' || (typeof raw.loglevel === 'number' && raw.loglevel >= 4) ? 60 : 20
  } else if (raw.event_type === 'connection') {
    eventType = 'network_event'
    severity = 20
  } else if (raw.syslog_program === 'sshd' || raw.syslog_program === 'sudo') {
    eventType = 'wazuh_alert'
    severity = raw.syslog_severity === 0 ? 80 : 30 // emergency/critical vs normal
  }

  // Determine source name
  const host = typeof raw.host === 'string' ? raw.host : (raw.host as Record<string, unknown>)?.name as string
  const sourceName = String(host ?? raw.syslog_hostname ?? raw.agent?.id ?? 'elk')

  // Dedup key
  const dedupSource = message || raw.message || ''
  const dedupKey = createDedupKey('elk', raw['@timestamp'] ?? '', sourceName, dedupSource.slice(0, 100))

  const timestamp = parseTimestamp(raw['@timestamp'] ?? raw.syslog_timestamp ?? '')

  return {
    id: `elk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    environmentId: null,
    type: eventType,
    source: 'elk',
    severity,
    title: buildTitle(raw, eventType),
    description: message.slice(0, 1000),
    rawEvent: raw as any,
    dedupKey,
    sourceName,
    timestamp,
    metadata: {
      anomaly_score: raw.anomaly_score,
      anomaly_bucket: raw.anomaly_bucket,
      src_ip: raw.source_ip ?? raw.src_ip,
      dst_ip: raw.dest_ip ?? raw.dst_ip,
      event_type: raw.event_type,
      user: raw.user,
      tags: raw.tags,
    },
  }
}

function buildTitle(raw: ElkEvent, eventType: string): string {
  if (raw.anomaly_bucket) {
    return `Anomaly detected: ${raw.anomaly_bucket} (score: ${raw.anomaly_score?.toFixed(2)})`
  }
  if (raw.message) {
    return raw.message.slice(0, 80)
  }
  if (raw.syslog_message) {
    return `${raw.syslog_program || 'syslog'}: ${raw.syslog_message.slice(0, 80)}`
  }
  return eventType
}

function parseTimestamp(ts: string): Date {
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
