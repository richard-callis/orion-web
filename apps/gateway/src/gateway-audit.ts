/**
 * Gateway audit event emitter.
 *
 * Emits SecurityEvent rows to the web app's ingestion endpoint after each
 * tool execution. This provides the correlation rule for gateway tool-call
 * audit (PR4): any single agent.tool.invoked event with severity >= 60
 * opens an Incident for human review.
 *
 * Source: gateway_audit
 * Type: agent.tool.invoked
 */

// Severity map: write-tier tools get high severity (triggers incident),
// read-tier tools get low severity (logged but no incident).
const TOOL_SEVERITY: Record<string, number> = {
  // Write-tier: state-changing actions
  crowdsec_decision_create: 80,
  crowdsec_decision_delete: 80,
  wazuh_active_response: 80,
  firewall_block: 80,
  // Policy-gated entry point
  security_propose_action: 60,
  // Read-tier: visibility only
  crowdsec_blocks: 20,
  crowdsec_suggestions: 20,
  ntopng_threats: 20,
  ntopng_top_talkers: 20,
  elk_flow_search: 20,
  elk_syslog_search: 20,
  prometheus_query: 10,
  prometheus_query_range: 10,
}

/** Default severity for unknown tools (no incident, but logged). */
const DEFAULT_SEVERITY = 10

export interface GatewayAuditEvent {
  type: string
  source: string
  severity: number
  toolName: string
  agent: string
  gatewayId?: string
  title: string
  description?: string
  rawEvent: Record<string, unknown>
}

const WEBHOOK_URL = process.env.GATEWAY_AUDIT_EVENT_URL ?? 'http://orion:3000/api/monitoring/security/events'
const WEBHOOK_SECRET = process.env.GATEWAY_AUDIT_SECRET
const GATEWAY_ID = process.env.ENVIRONMENT_ID || process.env.HOSTNAME || 'unknown'

/**
 * Emit a single gateway audit SecurityEvent to the web app.
 * Non-blocking: fires and forgets with a short timeout.
 */
export async function emitGatewayAuditEvent(event: GatewayAuditEvent): Promise<void> {
  if (!WEBHOOK_SECRET) {
    // Dev mode: skip if no secret configured
    return
  }

  const payload = {
    type: event.type,
    source: event.source,
    severity: event.severity,
    title: event.title,
    description: event.description,
    toolName: event.toolName,
    agent: event.agent,
    gatewayId: event.gatewayId || GATEWAY_ID,
    rawEvent: {
      toolName: event.toolName,
      agent: event.agent,
      severity: event.severity,
      ...event.rawEvent,
    },
  }

  // Non-blocking, 2s timeout
  try {
    await fetch(`${WEBHOOK_URL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // Fire-and-forget: don't break tool execution on emit failure
  }
}

/**
 * Get severity for a tool name.
 */
export function getToolSeverity(toolName: string): number {
  return TOOL_SEVERITY[toolName] ?? DEFAULT_SEVERITY
}

/**
 * Build a gateway_audit event from tool execution context.
 */
export function buildAuditEvent({
  toolName,
  result,
  args,
  gatewayId,
  error,
  agent,
}: {
  toolName: string
  result: string
  args: Record<string, unknown>
  gatewayId?: string
  error?: boolean
  agent?: string
}): GatewayAuditEvent {
  return {
    type: 'agent.tool.invoked',
    source: 'gateway_audit',
    severity: getToolSeverity(toolName),
    toolName,
    agent: agent ?? 'unknown',
    gatewayId,
    title: `Tool ${error ? 'failed' : 'executed'}: ${toolName}`,
    description: error ? `Tool ${toolName} execution failed` : `Tool ${toolName} completed successfully`,
    rawEvent: {
      result: result.slice(0, 1000), // truncate to avoid bloating the event
      args,
      error,
    },
  }
}
