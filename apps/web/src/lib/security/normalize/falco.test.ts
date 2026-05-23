import { describe, it, expect } from 'vitest'
import {
  falcoAlertSchema,
  falcoPrioritySeverity,
  isHeartbeat,
  normalizeFalcoAlert,
} from './falco'

describe('falcoPrioritySeverity', () => {
  it('maps known priorities per the spec table', () => {
    expect(falcoPrioritySeverity('EMERGENCY')).toBe(95)
    expect(falcoPrioritySeverity('ALERT')).toBe(90)
    expect(falcoPrioritySeverity('CRITICAL')).toBe(85)
    expect(falcoPrioritySeverity('ERROR')).toBe(75)
    expect(falcoPrioritySeverity('WARNING')).toBe(60)
    expect(falcoPrioritySeverity('NOTICE')).toBe(40)
    expect(falcoPrioritySeverity('INFO')).toBe(20)
    expect(falcoPrioritySeverity('INFORMATIONAL')).toBe(20)
    expect(falcoPrioritySeverity('DEBUG')).toBe(5)
  })

  it('is case-insensitive', () => {
    expect(falcoPrioritySeverity('warning')).toBe(60)
    expect(falcoPrioritySeverity('  Critical  ')).toBe(85)
  })

  it('defaults unknown priorities to 40 (NOTICE-equivalent), not high', () => {
    expect(falcoPrioritySeverity('WEIRD_THING')).toBe(40)
    expect(falcoPrioritySeverity('')).toBe(40)
  })
})

describe('isHeartbeat', () => {
  it('matches the literal Heartbeat rule name case-insensitively', () => {
    expect(isHeartbeat({ rule: 'Heartbeat', priority: 'DEBUG' } as any)).toBe(true)
    expect(isHeartbeat({ rule: 'heartbeat', priority: 'INFO' } as any)).toBe(true)
    expect(isHeartbeat({ rule: 'HEARTBEAT', priority: 'INFO' } as any)).toBe(true)
  })

  it('does not match other rules', () => {
    expect(
      isHeartbeat({ rule: 'Terminal shell in container', priority: 'WARNING' } as any)
    ).toBe(false)
    expect(isHeartbeat({ rule: 'Heartbeat failure', priority: 'ERROR' } as any)).toBe(false)
  })
})

describe('falcoAlertSchema', () => {
  it('accepts a minimal alert', () => {
    const result = falcoAlertSchema.safeParse({
      rule: 'Terminal shell in container',
      priority: 'WARNING',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing rule', () => {
    const result = falcoAlertSchema.safeParse({ priority: 'WARNING' })
    expect(result.success).toBe(false)
  })

  it('preserves output_fields verbatim', () => {
    const result = falcoAlertSchema.safeParse({
      rule: 'Sensitive file read',
      priority: 'CRITICAL',
      output_fields: {
        'fd.name': '/etc/shadow',
        'container.name': 'orion-gateway',
        environmentId: 'env_abc',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.output_fields['fd.name']).toBe('/etc/shadow')
      expect(result.data.output_fields.environmentId).toBe('env_abc')
    }
  })
})

describe('normalizeFalcoAlert', () => {
  const baseAlert = {
    rule: 'Terminal shell in container',
    priority: 'WARNING',
    output: 'A shell was spawned in container orion-gateway',
    output_fields: {
      'container.name': 'orion-gateway',
      'container.image': 'orion/gateway:1.2.3',
      'proc.name': 'bash',
      environmentId: 'env_abc',
    },
    time: '2026-05-22T14:00:00Z',
    hostname: 'managed-host-1',
  }

  it('maps priority WARNING to severity 60', () => {
    const ev = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    expect(ev.severity).toBe(60)
  })

  it('builds type as falco.<slugified-rule>', () => {
    const ev = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    expect(ev.type).toBe('falco.terminal_shell_in_container')
  })

  it('preserves environmentId in both top-level field and metadata', () => {
    const ev = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    expect(ev.environmentId).toBe('env_abc')
    expect((ev.metadata as any).environmentId).toBe('env_abc')
  })

  it('builds a deterministic dedupKey from envId|rule|hostname|container|time', () => {
    const ev1 = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    const ev2 = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    expect(ev1.dedupKey).toBe(ev2.dedupKey)

    // Changing environmentId changes the dedupKey
    const ev3 = normalizeFalcoAlert(baseAlert as any, 'env_xyz')
    expect(ev3.dedupKey).not.toBe(ev1.dedupKey)

    // Changing time changes the dedupKey
    const ev4 = normalizeFalcoAlert(
      { ...baseAlert, time: '2026-05-22T14:00:01Z' } as any,
      'env_abc'
    )
    expect(ev4.dedupKey).not.toBe(ev1.dedupKey)
  })

  it('places useful fields in metadata', () => {
    const ev = normalizeFalcoAlert(baseAlert as any, 'env_abc')
    expect(ev.metadata).toMatchObject({
      rule: 'Terminal shell in container',
      priority: 'WARNING',
      hostname: 'managed-host-1',
      container_name: 'orion-gateway',
      container_image: 'orion/gateway:1.2.3',
      proc_name: 'bash',
    })
  })

  it('handles missing optional fields gracefully', () => {
    const minimal = {
      rule: 'Custom rule',
      priority: 'INFO',
      output_fields: { environmentId: 'env_abc' },
    }
    const ev = normalizeFalcoAlert(minimal as any, 'env_abc')
    expect(ev.severity).toBe(20)
    expect((ev.metadata as any).container_name).toBe('unknown')
    expect((ev.metadata as any).hostname).toBe('unknown')
  })

  it('uses environmentId="host" verbatim for the Orion host', () => {
    const ev = normalizeFalcoAlert(baseAlert as any, 'host')
    expect(ev.environmentId).toBe('host')
    expect((ev.metadata as any).environmentId).toBe('host')
  })
})
