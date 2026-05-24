/**
 * Falco alert normalizer (Phase 2).
 *
 * Converts Falcosidekick webhook alerts into NormalizedSecurityEvent.
 *
 * Falco alerts arrive via Falcosidekick which POSTs JSON with this shape:
 *
 *   {
 *     "rule":     "Terminal shell in container",
 *     "priority": "WARNING",
 *     "output":   "A shell was spawned in a container ...",
 *     "output_fields": {
 *       "container.name":  "orion-gateway",
 *       "container.image": "orion/gateway:1.2.3",
 *       "proc.name":       "bash",
 *       "fd.name":         "/etc/shadow",
 *       "evt.type":        "open",
 *       "environmentId":   "<injected by Falcosidekick CUSTOMFIELDS>"
 *     },
 *     "time":     "2026-05-22T14:00:00Z",
 *     "hostname": "managed-host-1"
 *   }
 *
 * The "Heartbeat" rule is handled specially by the route — it updates
 * EnvironmentSourceHealth.lastSeenAt without producing a SecurityEvent.
 */
import crypto from 'crypto'
import { z } from 'zod'
import { type NormalizedSecurityEvent } from '../types'

// ── Wire schema ──────────────────────────────────────────────────────────────
// Falcosidekick payload — keep loose; output_fields varies per rule. We only
// require what we actually use.

export const falcoAlertSchema = z.object({
  rule: z.string(),
  priority: z.string(),
  output: z.string().optional().default(''),
  output_fields: z.record(z.unknown()).optional().default({}),
  time: z.string().optional(),
  hostname: z.string().optional(),
  // Falcosidekick sometimes wraps the alert in `customfields` — we read it
  // from `output_fields` because that's where CUSTOMFIELDS env-var injection
  // surfaces.
})

export type FalcoAlert = z.infer<typeof falcoAlertSchema>

// ── Priority → severity ──────────────────────────────────────────────────────
// Per phase2-managed-infra-telemetry.md priority table.

const PRIORITY_SEVERITY: Record<string, number> = {
  EMERGENCY: 95,
  ALERT: 90,
  CRITICAL: 85,
  ERROR: 75,
  WARNING: 60,
  NOTICE: 40,
  INFORMATIONAL: 20, // Falco emits "INFORMATIONAL"; map same as INFO
  INFO: 20,
  DEBUG: 5,
}

/**
 * Returns severity for a given Falco priority, defaulting to 40 (NOTICE-equivalent)
 * for any unknown priority value. Defaulting low rather than high so an unknown
 * rule never auto-pages.
 */
export function falcoPrioritySeverity(priority: string): number {
  const key = priority.trim().toUpperCase()
  return PRIORITY_SEVERITY[key] ?? 40
}

// ── Heartbeat detection ──────────────────────────────────────────────────────
// Falco can be configured to emit a periodic "Heartbeat" rule. We treat it as
// a liveness signal only — no SecurityEvent row, just a SourceHealth bump.

export function isHeartbeat(alert: FalcoAlert): boolean {
  return alert.rule.trim().toLowerCase() === 'heartbeat'
}

// ── Normalizer ───────────────────────────────────────────────────────────────

export interface NormalizedFalcoEvent extends NormalizedSecurityEvent {
  environmentId: string
}

/**
 * Normalize a Falco alert into a SecurityEvent draft.
 *
 * environmentId MUST be present in output_fields (injected by Falcosidekick
 * CUSTOMFIELDS at deploy time). The route rejects alerts that lack it.
 */
export function normalizeFalcoAlert(
  alert: FalcoAlert,
  environmentId: string
): NormalizedFalcoEvent {
  const fields = alert.output_fields ?? {}
  const containerName = stringField(fields, 'container.name') ?? 'unknown'
  const containerImage = stringField(fields, 'container.image') ?? null
  const procName = stringField(fields, 'proc.name') ?? null
  const fdName = stringField(fields, 'fd.name') ?? null
  const hostname = alert.hostname ?? 'unknown'

  const time = alert.time ?? new Date().toISOString()
  const severity = falcoPrioritySeverity(alert.priority)

  // dedupKey: environmentId|rule|hostname|container.name|time
  // Time is included so repeated identical alerts across batches still produce
  // separate rows — Falco's own dedup happens upstream.
  const dedupKey = sha256(
    [environmentId, alert.rule, hostname, containerName, time].join('|')
  )

  const type = `falco.${slugifyRule(alert.rule)}`

  return {
    environmentId,
    type,
    source: 'falco',
    severity,
    title: `Falco: ${alert.rule}`,
    description: alert.output || null,
    rawEvent: {
      rule: alert.rule,
      priority: alert.priority,
      output: alert.output,
      output_fields: fields,
      hostname,
      time,
    },
    dedupKey,
    sourceName: hostname,
    timestamp: new Date(time),
    metadata: {
      environmentId,
      rule: alert.rule,
      priority: alert.priority.toUpperCase(),
      hostname,
      container_name: containerName,
      container_image: containerImage,
      proc_name: procName,
      fd_name: fdName,
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stringField(fields: Record<string, unknown>, key: string): string | null {
  const v = fields[key]
  return typeof v === 'string' ? v : null
}

function slugifyRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}
