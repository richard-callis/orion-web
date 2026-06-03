/**
 * ntopng event normalizer.
 *
 * Converts ntopng flow events and threat detection alerts into NormalizedSecurityEvent.
 * ntopng provides both flow data and threat intelligence via its REST API.
 */

import crypto from 'crypto'
import { type NormalizedSecurityEvent } from '../types'

/**
 * A flow record from ntopng API or webhook.
 * ntopng flow format (simplified):
 */
export interface NtopngFlow {
  first_ts?: string
  last_ts?: string
  source_ip?: string
  source_name?: string
  dest_ip?: string
  dest_name?: string
  source_port?: number
  dest_port?: number
  bytes?: number
  packets?: number
  l4_protocol?: string
  ip_protocol?: string
  tcp_flags?: string
  http_method?: string
  http_url?: string
  http_code?: number
  http_domain?: string
  application?: string
  source_bytes?: number
  dest_bytes?: number
  source_to_dest_bytes?: number
  destination_to_source_bytes?: number
  source_to_dest_packets?: number
  destination_to_source_packets?: number
  source_mac?: string
  source_oui?: string
  dest_mac?: string
  dest_oui?: string
  vlan_id?: number
  vrf_id?: number
  interface_id?: number
  local_source?: boolean
  local_destination?: boolean
  source_geoip_country?: string
  dest_geoip_country?: string
  internal_source?: boolean
  internal_destination?: boolean
  dest_internal?: boolean
  source_internal?: boolean
  host_resolutions?: Array<{ ip: string; hostname: string }>
  is_web_server?: boolean
}

/**
 * A threat detection alert from ntopng.
 */
export interface NtopngThreatAlert {
  id?: string
  timestamp?: string
  alert_type?: string  // 'threat' | 'geoip' | 'spoofing' | 'port_scan' | 'ddos'
  alert_name?: string
  source_ip?: string
  source_port?: number
  dest_ip?: string
  dest_port?: number
  threat_type?: string
  description?: string
  severity?: string | number
  category?: string
  interface_id?: number
  vlan_id?: number
}

/**
 * Normalize an ntopng flow record into the canonical SecurityEvent shape.
 *
 * Flows are assessed for suspicious activity based on heuristics:
 * - Unusual port scanning patterns
 * - Large data transfers
 * - Known bad destinations (geoip)
 */
export function normalizeNtopngFlow(raw: NtopngFlow): NormalizedSecurityEvent {
  const eventType = detectFlowEventType(raw)
  const severity = assessFlowSeverity(raw, eventType)

  // Source/destination info
  const sourceIp = raw.source_ip ?? ''
  const destIp = raw.dest_ip ?? ''
  const sourceName = raw.source_name ?? sourceIp
  const destName = raw.dest_name ?? destIp ?? 'unknown'

  // Dedup key: source:dest:port:protocol
  const dedupKey = createDedupKey(
    'ntopng_flow',
    sourceIp,
    `${destIp}:${raw.dest_port ?? 0}:${raw.ip_protocol ?? 'tcp'}`
  )

  const timestamp = parseTimestamp(raw.first_ts ?? raw.last_ts ?? '')

  return {
    id: `ntopng_flow_${Date.now()}_${sourceIp}_${destIp}`,
    environmentId: null,
    type: eventType,
    source: 'ntopng',
    severity,
    title: buildFlowTitle(raw, eventType),
    description: buildFlowDescription(raw, eventType),
    rawEvent: raw as any,
    dedupKey,
    sourceName,
    timestamp,
    metadata: {
      source_port: raw.source_port,
      dest_port: raw.dest_port,
      application: raw.application,
      bytes: raw.bytes,
      packets: raw.packets,
      geoip: {
        source_country: raw.source_geoip_country,
        dest_country: raw.dest_geoip_country,
      },
      is_web_server: raw.is_web_server,
    },
  }
}

/**
 * Normalize an ntopng threat alert.
 */
export function normalizeNtopngThreatAlert(raw: NtopngThreatAlert): NormalizedSecurityEvent {
  const severity = parseSeverity(raw.severity, raw.alert_type)
  const sourceIp = raw.source_ip ?? 'unknown'
  const destIp = raw.dest_ip ?? 'unknown'

  const dedupKey = createDedupKey(
    'ntopng_threat',
    raw.id ?? raw.alert_name ?? '',
    sourceIp,
    destIp
  )

  const timestamp = parseTimestamp(raw.timestamp ?? '')

  const isPortScan = raw.alert_type === 'port_scan'
  const eventType = isPortScan ? 'ntopng_port_scan' : 'ntopng_threat'
  const title = isPortScan
    ? `Port scan detected from ${sourceIp}`
    : raw.alert_name ?? raw.alert_type ?? 'ntopng threat detected'

  return {
    id: raw.id ?? `ntopng_threat_${Date.now()}`,
    environmentId: null,
    type: eventType,
    source: 'ntopng',
    severity,
    title,
    description: raw.description ?? `Alert type: ${raw.alert_type}`,
    rawEvent: raw as any,
    dedupKey,
    sourceName: sourceIp,
    timestamp,
    metadata: {
      alert_type: raw.alert_type,
      threat_type: raw.threat_type,
      category: raw.category,
      source_port: raw.source_port,
      dest_port: raw.dest_port,
      interface_id: raw.interface_id,
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function detectFlowEventType(raw: NtopngFlow): string {
  if (raw.application && raw.application.toLowerCase().includes('malware')) return 'ntopng_threat'
  if (raw.bytes && raw.bytes > 100_000_000) return 'ntopng_large_transfer'
  if (raw.source_to_dest_packets && raw.source_to_dest_packets > 1000 && (raw.dest_port === 22 || raw.dest_port === 23)) return 'ntopng_bruteforce'
  // Port scan heuristic: many small packets spread across many dest ports from same source
  if (raw.packets && raw.packets < 5 && raw.source_to_dest_packets && raw.source_to_dest_packets >= 1) return 'ntopng_flow'
  return 'ntopng_flow'
}

function assessFlowSeverity(raw: NtopngFlow, eventType: string): number {
  if (eventType === 'ntopng_threat') return 80
  if (eventType === 'ntopng_bruteforce') return 70
  if (eventType === 'ntopng_large_transfer') {
    const ratio = raw.bytes ? (raw.source_to_dest_bytes ?? 0) / raw.bytes : 0
    return ratio > 0.9 ? 50 : 20
  }

  // Base severity for normal flows
  let severity = 5

  // High port from unusual source
  if (raw.dest_port && (raw.dest_port === 4444 || raw.dest_port === 5555 || raw.dest_port === 6666 || raw.dest_port === 6667)) severity += 40

  // Foreign country connection
  if (raw.dest_geoip_country && !['US', 'CA', 'GB', 'DE', 'FR'].includes(raw.dest_geoip_country)) severity += 10

  return Math.min(100, severity)
}

function buildFlowTitle(raw: NtopngFlow, eventType: string): string {
  const src = raw.source_name ?? raw.source_ip ?? 'unknown'
  const dst = raw.dest_name ?? raw.dest_ip ?? 'unknown'
  const port = raw.dest_port ?? 0

  switch (eventType) {
    case 'ntopng_threat':
      return `Threat detected: ${src} → ${dst}:${port}`
    case 'ntopng_large_transfer':
      return `Large transfer: ${src} → ${dst} (${raw.bytes ?? 0} bytes)`
    case 'ntopng_bruteforce':
      return `Potential brute force: ${src} → ${dst}:${port}`
    default: {
      if (raw.application) return `${raw.application}: ${src} → ${dst}:${port}`
      return `${src}:${raw.source_port ?? 0} → ${dst}:${port}`
    }
  }
}

function buildFlowDescription(raw: NtopngFlow, eventType: string): string {
  const parts: string[] = []
  if (raw.application) parts.push(`App: ${raw.application}`)
  if (raw.bytes) parts.push(`${raw.bytes.toLocaleString()} bytes, ${raw.packets ?? 0} packets`)
  if (raw.source_geoip_country) parts.push(`Source: ${raw.source_geoip_country}`)
  if (raw.dest_geoip_country) parts.push(`Dest: ${raw.dest_geoip_country}`)
  return parts.join(' | ')
}

function parseSeverity(severity?: string | number, alertType?: string): number {
  if (severity != null) {
    const num = typeof severity === 'number' ? severity : parseInt(severity, 10)
    if (!Number.isNaN(num)) return Math.min(100, Math.max(0, num * 10))
  }
  // Defaults by type
  if (alertType === 'ddos') return 90
  if (alertType === 'spoofing') return 85
  if (alertType === 'geoip') return 50
  if (alertType === 'port_scan') return 60
  return 40
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
  return `${source}_${crypto.createHash('sha256').update(parts.join(':')).digest('hex')}`
}
