import { describe, it, expect } from 'vitest'
import { getToolSeverity, buildAuditEvent } from './gateway-audit'

describe('getToolSeverity', () => {
  it('returns 80 for write-tier tools', () => {
    expect(getToolSeverity('crowdsec_decision_create')).toBe(80)
    expect(getToolSeverity('crowdsec_decision_delete')).toBe(80)
    expect(getToolSeverity('wazuh_active_response')).toBe(80)
    expect(getToolSeverity('firewall_block')).toBe(80)
  })

  it('returns 60 for security_propose_action', () => {
    expect(getToolSeverity('security_propose_action')).toBe(60)
  })

  it('returns 20 for read-tier security tools', () => {
    expect(getToolSeverity('crowdsec_blocks')).toBe(20)
    expect(getToolSeverity('ntopng_threats')).toBe(20)
    expect(getToolSeverity('elk_flow_search')).toBe(20)
  })

  it('returns 10 for unknown tools', () => {
    expect(getToolSeverity('some_unknown_tool')).toBe(10)
  })
})

describe('buildAuditEvent', () => {
  it('creates a correct audit event for a successful tool call', () => {
    const event = buildAuditEvent({
      toolName: 'crowdsec_decision_create',
      result: JSON.stringify({ success: true, ip: '1.2.3.4' }),
      args: { ip: '1.2.3.4' },
      error: false,
    })

    expect(event.type).toBe('agent.tool.invoked')
    expect(event.source).toBe('gateway_audit')
    expect(event.severity).toBe(80)
    expect(event.toolName).toBe('crowdsec_decision_create')
    expect(event.title).toBe('Tool executed: crowdsec_decision_create')
    expect(event.rawEvent.error).toBe(false)
  })

  it('creates an audit event for a failed tool call', () => {
    const event = buildAuditEvent({
      toolName: 'firewall_block',
      result: 'Error: timeout',
      args: { cidr: '10.0.0.0/24' },
      error: true,
    })

    expect(event.severity).toBe(80)
    expect(event.title).toBe('Tool failed: firewall_block')
    expect(event.rawEvent.error).toBe(true)
  })

  it('truncates result to 1000 chars', () => {
    const longResult = 'x'.repeat(2000)
    const event = buildAuditEvent({
      toolName: 'elk_syslog_search',
      result: longResult,
      args: {},
      error: false,
    })

    expect(event.rawEvent.result.length).toBe(1000)
  })
})
