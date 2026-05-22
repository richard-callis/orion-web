/**
 * Shared security types — used across webhooks, pollers, correlator, and action-service.
 *
 * Types:
 *   NormalizedSecurityEvent  — canonical event shape from any ingestion source
 *   IncidentDraft            — correlation engine output; input to Incident creation
 *   ActionRequest            — proposed action with target and reasoning
 *   ActionDecision           — tiered decision on an ActionRequest
 */

import { z } from 'zod'

// ── NormalizedSecurityEvent ────────────────────────────────────────────────────
// Canonical shape for all ingestion sources (webhooks + pollers).

export const normalizedEventSchema = z.object({
  id:          z.string().uuid().optional(),
  environmentId: z.string().nullable().optional(),
  type:        z.string(),           // e.g. 'crowdsec_block', 'wazuh_alert', 'anomaly', 'source_stale'
  source:      z.string(),           // e.g. 'crowdsec', 'wazuh', 'elk', 'ntopng'
  severity:    z.number().int().min(0).max(100),
  title:       z.string(),
  description: z.string().nullable().optional(),
  rawEvent:    z.record(z.unknown()),
  dedupKey:    z.string(),
  sourceName:  z.string().optional(), // hostname / agent identifier
  timestamp:   z.coerce.date().optional(),
  metadata:    z.record(z.unknown()).nullable().optional(),
})

export type NormalizedSecurityEvent = z.infer<typeof normalizedEventSchema>

// ── IncidentDraft ─────────────────────────────────────────────────────────────
// Output of the correlation engine; input to Incident creation.

export const incidentDraftSchema = z.object({
  severity:         z.number().int().min(0).max(100),
  rootCauseSummary: z.string().nullable().optional(),
  attackerKey:      z.string().nullable().optional(),
  hostKey:          z.string().nullable().optional(),
  eventIds:         z.array(z.string().uuid()), // SecurityEvent IDs that triggered this
  ruleName:         z.string(),                  // CorrelationRule.name that matched
  environmentId:    z.string().nullable().optional(),
})

export type IncidentDraft = z.infer<typeof incidentDraftSchema>

// ── ActionRequest ─────────────────────────────────────────────────────────────
// Proposed action from Warden or system; input to action-service.decide().

export const actionRequestSchema = z.object({
  actionType: z.string(),     // matches ActionPolicy.actionType
  target:     z.string(),     // IP, CIDR, hostname, etc.
  incidentId: z.string().uuid().nullable().optional(),
  reason:     z.string(),     // Why this action is proposed
  payload:    z.record(z.unknown()).nullable().optional(), // Raw action params
})

export type ActionRequest = z.infer<typeof actionRequestSchema>

// ── ActionDecision ────────────────────────────────────────────────────────────
// Output of action-service.decide(); feeds action-executor.

export const actionDecisionSchema = z.object({
  actionType: z.string(),
  target:     z.string(),
  tier:       z.enum(['auto', 'approve', 'escalate', 'notify']),
  approvedBy: z.string().nullable().optional(),
  denied:     z.boolean().optional().default(false),
  denialReason: z.string().nullable().optional(),
  incidentId: z.string().uuid().nullable().optional(),
  panicMode:  z.boolean().optional().default(false),
})

export type ActionDecision = z.infer<typeof actionDecisionSchema>

// ── HostAgentEventBatch ───────────────────────────────────────────────────────
// Wire format for the host-agent ingest webhook.
// Vector ships a batch envelope so the endpoint can process multiple events
// in one HTTP call — critical for throughput on the Orion host.
//
// Divergence from existing webhooks: crowdsec / wazuh accept singleton events
// because that's how those upstreams push. Host-agent is fundamentally log
// shipping — Vector batches natively, and forcing one request per event would
// burn CPU on the host and add latency.

/** Valid event categories from the host agent. */
export const HOST_AGENT_CATEGORIES = [
  'auth',
  'docker',
  'vault',
  'edge',
] as const

export const hostAgentEventSchema = z.object({
  category:   z.enum(HOST_AGENT_CATEGORIES),
  subtype:    z.string(),   // e.g. 'ssh.failed_password', 'container.restarted'
  severity:   z.number().int().min(0).max(100),
  timestamp:  z.coerce.date(),
  source_file: z.string().optional(), // journald tag, container name, file path
  raw:        z.string(),              // original log line or excerpt
})

export const hostAgentBatchSchema = z.object({
  batch_id: z.string(),
  hostname: z.string(),
  events:   z.array(hostAgentEventSchema),
})

export type HostAgentEvent = z.infer<typeof hostAgentEventSchema>
export type HostAgentEventBatch = z.infer<typeof hostAgentBatchSchema>
