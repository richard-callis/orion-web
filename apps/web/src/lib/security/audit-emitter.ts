/**
 * Security audit emitter — emit SecurityEvents from server-side tool execution.
 *
 * Called from the tool execution hot path (room-agents.ts) for high-risk operations.
 * Writes directly to the DB (no HTTP round-trip) and fires-and-forgets so it
 * never blocks the agent response.
 */

import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db'

export interface AuditEvent {
  toolName: string
  args: Record<string, unknown>
  agentId: string
  agentName?: string
  environmentId?: string | null
  /** Whether the tool was actually executed or denied by permission checks. */
  outcome: 'executed' | 'denied'
}

/** Tools and their risk classification (severity 0-100). */
const TOOL_RISK: Record<string, { severity: number; type: string; label: string }> = {
  // Container / process execution
  kubectl_exec:              { severity: 75, type: 'container_exec',  label: 'kubectl exec into container' },
  docker_exec:               { severity: 75, type: 'container_exec',  label: 'docker exec into container' },
  docker_run:                { severity: 65, type: 'container_exec',  label: 'docker run' },
  execute_command:           { severity: 60, type: 'shell_execution', label: 'Shell command executed' },
  bash:                      { severity: 60, type: 'shell_execution', label: 'Bash command executed' },
  run_command:               { severity: 60, type: 'shell_execution', label: 'Command executed' },
  // K8s destructive ops
  kubectl_delete:            { severity: 70, type: 'k8s_delete',      label: 'Kubernetes resource deleted' },
  kubectl_apply:             { severity: 55, type: 'k8s_modify',      label: 'Kubernetes resource modified' },
  kubectl_patch:             { severity: 55, type: 'k8s_modify',      label: 'Kubernetes resource patched' },
  kubectl_scale:             { severity: 50, type: 'k8s_modify',      label: 'Kubernetes deployment scaled' },
  kubectl_drain:             { severity: 70, type: 'k8s_modify',      label: 'Kubernetes node drained' },
  kubectl_rollout:           { severity: 55, type: 'k8s_modify',      label: 'Kubernetes rollout triggered' },
  // Security policy changes
  crowdsec_create_decision:  { severity: 65, type: 'security_policy', label: 'CrowdSec decision created' },
  crowdsec_delete_decision:  { severity: 65, type: 'security_policy', label: 'CrowdSec decision deleted' },
  // File system ops
  write_file:                { severity: 40, type: 'file_write',      label: 'File written by agent' },
  delete_file:               { severity: 65, type: 'file_delete',     label: 'File deleted by agent' },
}

/** Scan string values in args recursively for dangerous patterns. */
const DANGEROUS_PATTERNS = [
  /rm\s+-[rf]{1,2}\b/i,
  /DROP\s+TABLE/i,
  /chmod\s+[0-7]*7[0-7]{2}/i,  // world-writable bits
  /curl[^|]*\|\s*(ba)?sh/i,
  /wget[^|]*\|\s*(ba)?sh/i,
  /\/etc\/shadow\b/i,
]

function scanStringValues(val: unknown): boolean {
  if (typeof val === 'string') return DANGEROUS_PATTERNS.some(re => re.test(val))
  if (Array.isArray(val)) return val.some(scanStringValues)
  if (val !== null && typeof val === 'object') return Object.values(val as object).some(scanStringValues)
  return false
}

/** Throttle the sourceHealth heartbeat to once per 30s in-process. */
let lastHeartbeatMs = 0
function maybeHeartbeat() {
  const now = Date.now()
  if (now - lastHeartbeatMs < 30_000) return Promise.resolve()
  lastHeartbeatMs = now
  return prisma.sourceHealth.upsert({
    where: { source: 'gateway_audit' },
    update: { lastSeenAt: new Date(now) },
    create: { source: 'gateway_audit', lastSeenAt: new Date(now), lastWatermark: null, staleAfterMs: 3_600_000 },
  })
}

/**
 * Emit a SecurityEvent if the tool is considered high-risk.
 * Fires and forgets — never throws, never blocks the caller.
 */
export function auditToolCall(event: AuditEvent): void {
  let hasDangerousArgs = false
  try {
    hasDangerousArgs = scanStringValues(event.args)
  } catch {
    // Non-serializable args — treat as potentially dangerous
    hasDangerousArgs = true
  }

  const risk = TOOL_RISK[event.toolName]
  if (!risk && !hasDangerousArgs) return

  const severity = risk
    ? (hasDangerousArgs ? Math.min(100, risk.severity + 20) : risk.severity)
    : (hasDangerousArgs ? 70 : 40)

  // Use the tool's natural type; only fall back to shell_execution for unknown tools
  const type = risk?.type ?? 'shell_execution'
  const actionVerb = event.outcome === 'denied' ? '(denied)' : ''
  const label = (risk?.label ?? `Tool call: ${event.toolName}`) + (actionVerb ? ` ${actionVerb}` : '')
  const agentLabel = event.agentName ?? `agent:${event.agentId.slice(0, 8)}`

  // Include a dangerous-args flag in the dedup key so a clean call and a dirty
  // call in the same minute produce separate events (different severity/description)
  const dangerFlag = hasDangerousArgs ? '1' : '0'
  const dedupKey = crypto.createHash('sha256')
    .update(`${event.toolName}:${event.agentId}:${Math.floor(Date.now() / 60_000)}:${dangerFlag}`)
    .digest('hex')

  const now = new Date()

  let rawEvent: Prisma.InputJsonValue
  try {
    rawEvent = JSON.parse(JSON.stringify({ toolName: event.toolName, agentId: event.agentId, outcome: event.outcome }))
  } catch {
    rawEvent = { toolName: event.toolName, agentId: event.agentId, outcome: event.outcome }
  }

  // Fire and forget
  prisma.securityEvent.findFirst({ where: { dedupKey }, select: { id: true } })
    .then(existing => {
      if (existing) {
        return prisma.securityEvent.update({ where: { id: existing.id }, data: { lastSeen: now } })
      }
      return prisma.securityEvent.create({
        data: {
          environmentId: event.environmentId ?? null,
          type,
          source: 'gateway_audit',
          severity,
          title: `${label} by ${agentLabel}`,
          description: hasDangerousArgs
            ? `Dangerous pattern in args for tool '${event.toolName}' (outcome: ${event.outcome})`
            : `High-risk tool by ${agentLabel} (outcome: ${event.outcome})`,
          rawEvent,
          dedupKey,
          firstSeen: now,
          lastSeen: now,
        },
      })
    })
    .then(() => { maybeHeartbeat().catch(() => {}) })
    .catch(err => console.warn('[security-audit] failed to emit event:', err))
}
