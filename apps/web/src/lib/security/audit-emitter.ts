/**
 * Security audit emitter — emit SecurityEvents from server-side tool execution.
 *
 * Called from the tool execution hot path (room-agents.ts) for high-risk operations.
 * Writes directly to the DB (no HTTP round-trip) and fires-and-forgets so it
 * never blocks the agent response.
 */

import crypto from 'crypto'
import { prisma } from '../db'

interface AuditEvent {
  toolName: string
  args: Record<string, unknown>
  agentId: string
  agentName?: string
  environmentId?: string | null
}

/** Tools and their risk classification (severity 0-100). */
const TOOL_RISK: Record<string, { severity: number; type: string; label: string }> = {
  // Container / process execution
  kubectl_exec:           { severity: 75, type: 'container_exec',     label: 'kubectl exec into container' },
  docker_exec:            { severity: 75, type: 'container_exec',     label: 'docker exec into container' },
  execute_command:        { severity: 60, type: 'shell_execution',    label: 'Shell command executed' },
  bash:                   { severity: 60, type: 'shell_execution',    label: 'Bash command executed' },
  run_command:            { severity: 60, type: 'shell_execution',    label: 'Command executed' },
  // K8s destructive ops
  kubectl_delete:         { severity: 70, type: 'k8s_delete',         label: 'Kubernetes resource deleted' },
  kubectl_apply:          { severity: 55, type: 'k8s_modify',         label: 'Kubernetes resource modified' },
  kubectl_patch:          { severity: 55, type: 'k8s_modify',         label: 'Kubernetes resource patched' },
  kubectl_scale:          { severity: 50, type: 'k8s_modify',         label: 'Kubernetes deployment scaled' },
  // Security policy changes
  crowdsec_create_decision: { severity: 65, type: 'security_policy',  label: 'CrowdSec decision created' },
  crowdsec_delete_decision: { severity: 65, type: 'security_policy',  label: 'CrowdSec decision deleted' },
  // File system ops
  write_file:             { severity: 40, type: 'file_write',         label: 'File written by agent' },
  delete_file:            { severity: 65, type: 'file_delete',        label: 'File deleted by agent' },
}

/** Patterns in command args that bump severity. */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i, /DROP\s+TABLE/i, /chmod\s+777/i,
  /curl.*\|\s*bash/i, /wget.*\|\s*sh/i,
  /base64\s+-d/i, /\/etc\/passwd/i, /\/etc\/shadow/i,
]

function scanArgsForDangerousPatterns(args: Record<string, unknown>): boolean {
  const flat = JSON.stringify(args)
  return DANGEROUS_PATTERNS.some(re => re.test(flat))
}

/**
 * Emit a SecurityEvent if the tool is considered high-risk.
 * Fires and forgets — never throws, never blocks the caller.
 */
export function auditToolCall(event: AuditEvent): void {
  const risk = TOOL_RISK[event.toolName]
  const hasDangerousArgs = scanArgsForDangerousPatterns(event.args)

  // Skip if low-risk tool and args are clean
  if (!risk && !hasDangerousArgs) return

  const severity = risk
    ? (hasDangerousArgs ? Math.min(100, risk.severity + 20) : risk.severity)
    : (hasDangerousArgs ? 70 : 40)

  const type = risk?.type ?? 'shell_execution'
  const label = risk?.label ?? `Tool call: ${event.toolName}`
  const agentLabel = event.agentName ? `agent:${event.agentName}` : `agent:${event.agentId.slice(0, 8)}`

  const dedupKey = crypto.createHash('sha256')
    .update(`${event.toolName}:${event.agentId}:${Math.floor(Date.now() / 60_000)}`)
    .digest('hex')

  const now = new Date()

  // Fire and forget — log errors but never surface them to the caller
  prisma.securityEvent.findFirst({ where: { dedupKey }, select: { id: true } }).then(existing =>
    existing
      ? prisma.securityEvent.update({ where: { id: existing.id }, data: { lastSeen: now } })
      : prisma.securityEvent.create({
          data: {
            environmentId: event.environmentId ?? null,
            type,
            source: 'gateway_audit',
            severity,
            title: `${label} by ${agentLabel}`,
            description: hasDangerousArgs
              ? `Dangerous pattern detected in args. Tool: ${event.toolName}`
              : `High-risk tool called by ${agentLabel}`,
            rawEvent: JSON.parse(JSON.stringify({ toolName: event.toolName, args: event.args, agentId: event.agentId })),
            dedupKey,
            firstSeen: now,
            lastSeen: now,
          },
        })
  ).then(() =>
    prisma.sourceHealth.upsert({
      where: { source: 'gateway_audit' },
      update: { lastSeenAt: new Date() },
      create: { source: 'gateway_audit', lastSeenAt: new Date(), lastWatermark: null, staleAfterMs: 3_600_000 },
    })
  ).catch(err => {
    console.warn('[security-audit] failed to emit event:', err)
  })
}
