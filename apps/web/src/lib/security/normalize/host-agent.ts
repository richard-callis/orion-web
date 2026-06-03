/**
 * Host-agent event normalizer.
 *
 * Converts individual events from the Vector-host-agent shipper into
 * NormalizedSecurityEvent. The webhook route iterates the batch and feeds
 * each event here; this normalizer stays per-event so it matches the
 * existing normalize/{crowdsec,wazuh,elk,ntopng} pattern.
 *
 * Severity mapping (from SIEM_PHASE1_PLAN.md):
 *   auth.ssh.failed_password  → 40
 *   auth.sudo.failed          → 50
 *   auth.ssh.invalid_user     → 20
 *   auth.pam.failure          → 30
 *   auth.sudo.success         → 30
 *   docker.container.oom      → 30
 *   docker.container.dead     → 40
 *   docker.image.pull         → 20
 *   docker.image.pull.unknown_registry → 60
 *   vault.unseal              → 50
 *   vault.token.create.root   → 70
 *   vault.token.create        → 40
 *   vault.policy.change       → 50
 *   edge.auth.denied          → 30
 *   edge.auth.success         → 10
 *   edge.http.deny            → 20
 *   docker.volume.create      → 0
 */

import crypto from 'crypto'
import { type NormalizedSecurityEvent } from '../types'

export interface HostAgentEvent {
  category: string
  subtype: string
  severity: number
  timestamp: string | Date
  source_file?: string
  raw: string
  hostname?: string
}

/**
 * Severity override table. Returns an explicit severity when the category+subtype
 * maps to a known pattern, otherwise returns null to use the event's own severity.
 */
export const SEVERITY_RULES: Array<{
  category: string
  pattern: RegExp
  severity: number
  eventType: string
  title: string
}> = [
  // ── auth (journald: SSH + sudo) ───────────────────────────────────────
  {
    category: 'auth',
    pattern: /^ssh\.failed_password$/,
    severity: 40,
    eventType: 'auth.ssh.failed_password',
    title: 'SSH failed password',
  },
  {
    category: 'auth',
    pattern: /^ssh\.invalid_user$/,
    severity: 20,
    eventType: 'auth.ssh.invalid_user',
    title: 'SSH invalid user login attempt',
  },
  {
    category: 'auth',
    pattern: /^ssh\.invalid_password$/,
    severity: 40,
    eventType: 'auth.ssh.invalid_password',
    title: 'SSH invalid password login attempt',
  },
  {
    category: 'auth',
    pattern: /^sudo\.failed$/,
    severity: 50,
    eventType: 'auth.sudo.failed',
    title: 'Sudo authentication failure',
  },
  {
    category: 'auth',
    pattern: /^sudo\.success$/,
    severity: 30,
    eventType: 'auth.sudo.success',
    title: 'Sudo command executed',
  },
  {
    category: 'auth',
    pattern: /^pam\.failure$/,
    severity: 30,
    eventType: 'auth.pam.failure',
    title: 'PAM authentication failure',
  },
  {
    category: 'auth',
    pattern: /^auth\.generic$/,
    severity: 30,
    eventType: 'auth.generic',
    title: 'Generic authentication failure',
  },
  // ── docker ───────────────────────────────────────────────────────────
  {
    category: 'docker',
    pattern: /^container\.oom$/,
    severity: 30,
    eventType: 'docker.container.oom',
    title: 'Container OOM killed',
  },
  {
    category: 'docker',
    pattern: /^container\.dead$/,
    severity: 40,
    eventType: 'docker.container.dead',
    title: 'Container stopped unexpectedly',
  },
  {
    category: 'docker',
    pattern: /^container\.restarted$/,
    severity: 20,
    eventType: 'docker.container.restarted',
    title: 'Container auto-restarted',
  },
  {
    category: 'docker',
    pattern: /^image\.pull\.unknown_registry$/,
    severity: 60,
    eventType: 'docker.image.pull.unknown_registry',
    title: 'Image pull from unknown registry',
  },
  {
    category: 'docker',
    pattern: /^image\.pull$/,
    severity: 20,
    eventType: 'docker.image.pull',
    title: 'Docker image pulled',
  },
  {
    category: 'docker',
    pattern: /^volume\.create$/,
    severity: 0,
    eventType: 'docker.volume.create',
    title: 'Docker volume created',
  },
  {
    category: 'docker',
    pattern: /^network\.create$/,
    severity: 0,
    eventType: 'docker.network.create',
    title: 'Docker network created',
  },
  // ── vault ────────────────────────────────────────────────────────────
  {
    category: 'vault',
    pattern: /^unseal$/,
    severity: 50,
    eventType: 'vault.unseal',
    title: 'Vault unsealed',
  },
  {
    category: 'vault',
    pattern: /^token\.create\.root$/,
    severity: 70,
    eventType: 'vault.token.create.root',
    title: 'Vault root token created',
  },
  {
    category: 'vault',
    pattern: /^token\.create$/,
    severity: 40,
    eventType: 'vault.token.create',
    title: 'Vault token created',
  },
  {
    category: 'vault',
    pattern: /^policy\.change$/,
    severity: 50,
    eventType: 'vault.policy.change',
    title: 'Vault policy modified',
  },
  {
    category: 'vault',
    pattern: /^token\.revoke$/,
    severity: 40,
    eventType: 'vault.token.revoke',
    title: 'Vault token revoked',
  },
  // ── edge (Traefik + Authentik) ───────────────────────────────────────
  {
    category: 'edge',
    pattern: /^auth\.denied$/,
    severity: 30,
    eventType: 'edge.auth.denied',
    title: 'Edge authentication denied',
  },
  {
    category: 'edge',
    pattern: /^auth\.success$/,
    severity: 10,
    eventType: 'edge.auth.success',
    title: 'Edge authentication success',
  },
  {
    category: 'edge',
    pattern: /^http\.deny$/,
    severity: 20,
    eventType: 'edge.http.deny',
    title: 'Edge HTTP request denied',
  },
  {
    category: 'edge',
    pattern: /^http\.blocked$/,
    severity: 30,
    eventType: 'edge.http.blocked',
    title: 'Edge HTTP request blocked',
  },
]

/**
 * Normalize a single host-agent event into the canonical SecurityEvent shape.
 */
export function normalizeHostAgentEvent(
  event: HostAgentEvent,
  hostname: string
): NormalizedSecurityEvent {
  const rule = SEVERITY_RULES.find(
    (r) => r.category === event.category && r.pattern.test(event.subtype)
  )

  const type = rule?.eventType ?? `${event.category}.${event.subtype}`
  const severity = rule?.severity ?? event.severity
  const title = rule?.title ?? `${event.category}: ${event.subtype}`

  // Build dedup key: hostname + source_file + timestamp + subtype + truncated raw
  const sourceFile = event.source_file ?? 'unknown'
  const rawExcerpt = event.raw.slice(0, 100)
  const dedupKey = createDedupKey(
    hostname,
    sourceFile,
    typeof event.timestamp === 'string' ? event.timestamp : event.timestamp.toISOString(),
    event.subtype,
    rawExcerpt
  )

  const timestamp =
    typeof event.timestamp === 'string' ? new Date(event.timestamp) : event.timestamp

  // Extract source IP from SSH log lines so the brute-force rule can group by attackerKey.
  // Formats: "Failed password for ... from 1.2.3.4 port ..."
  //          "Invalid user ... from 1.2.3.4 port ..."
  //          "Connection from 1.2.3.4 port ..."
  const srcIpMatch = event.category === 'auth'
    ? event.raw.match(/(?:from|connection from)\s+([\d.a-fA-F:]+)\s+port/i)
    : null
  const src_ip = srcIpMatch?.[1] ?? null

  return {
    id: undefined, // route assigns UUID via crypto.randomUUID()
    environmentId: null,
    type,
    source: 'host_agent',
    severity,
    title: `${title} on ${hostname}`,
    description: event.raw,
    rawEvent: {
      category: event.category,
      subtype: event.subtype,
      source_file: sourceFile,
      raw: event.raw,
      hostname,
      ...(src_ip ? { src_ip } : {}),
    },
    dedupKey,
    sourceName: hostname,
    timestamp,
    metadata: {
      hostname,
      category: event.category,
      subtype: event.subtype,
      source_file: sourceFile,
    },
  }
}

function createDedupKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}
