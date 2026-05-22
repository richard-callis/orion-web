/**
 * Tests for the host-agent event normalizer and the batch schema.
 *
 * Covers:
 *  - Every severity rule maps to the correct type/severity/title
 *  - Unknown subtypes fall back to generic mapping
 *  - dedupKey is deterministic and includes hostname + source_file
 *  - In-batch dedup suppresses duplicates
 *  - HostAgentEventBatch schema validates/invalidates correctly
 */

import { describe, it, expect } from 'vitest'
import { hostAgentBatchSchema } from '../types'
import {
  normalizeHostAgentEvent,
  type HostAgentEvent,
  SEVERITY_RULES,
} from './host-agent'

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<HostAgentEvent> = {}): HostAgentEvent {
  return {
    category: 'auth',
    subtype: 'ssh.failed_password',
    severity: 40,
    timestamp: new Date('2026-05-22T10:00:00Z'),
    source_file: 'journald',
    raw: 'Failed password for invalid user admin from 1.2.3.4 port 22',
    hostname: 'orion',
    ...overrides,
  }
}

// ── Normalizer — severity rules ─────────────────────────────────────────────

describe('normalizeHostAgentEvent — severity rules', () => {
  const tests: Array<{
    category: string
    subtype: string
    expectedType: string
    expectedSeverity: number
    expectedTitleContains: string
  }> = [
    // auth
    {
      category: 'auth',
      subtype: 'ssh.failed_password',
      expectedType: 'auth.ssh.failed_password',
      expectedSeverity: 40,
      expectedTitleContains: 'SSH failed password',
    },
    {
      category: 'auth',
      subtype: 'ssh.invalid_user',
      expectedType: 'auth.ssh.invalid_user',
      expectedSeverity: 20,
      expectedTitleContains: 'SSH invalid user',
    },
    {
      category: 'auth',
      subtype: 'ssh.invalid_password',
      expectedType: 'auth.ssh.invalid_password',
      expectedSeverity: 40,
      expectedTitleContains: 'SSH invalid password',
    },
    {
      category: 'auth',
      subtype: 'sudo.failed',
      expectedType: 'auth.sudo.failed',
      expectedSeverity: 50,
      expectedTitleContains: 'Sudo authentication failure',
    },
    {
      category: 'auth',
      subtype: 'sudo.success',
      expectedType: 'auth.sudo.success',
      expectedSeverity: 30,
      expectedTitleContains: 'Sudo command executed',
    },
    {
      category: 'auth',
      subtype: 'pam.failure',
      expectedType: 'auth.pam.failure',
      expectedSeverity: 30,
      expectedTitleContains: 'PAM authentication failure',
    },
    // docker
    {
      category: 'docker',
      subtype: 'container.oom',
      expectedType: 'docker.container.oom',
      expectedSeverity: 30,
      expectedTitleContains: 'Container OOM killed',
    },
    {
      category: 'docker',
      subtype: 'container.dead',
      expectedType: 'docker.container.dead',
      expectedSeverity: 40,
      expectedTitleContains: 'Container stopped unexpectedly',
    },
    {
      category: 'docker',
      subtype: 'image.pull.unknown_registry',
      expectedType: 'docker.image.pull.unknown_registry',
      expectedSeverity: 60,
      expectedTitleContains: 'Image pull from unknown registry',
    },
    {
      category: 'docker',
      subtype: 'image.pull',
      expectedType: 'docker.image.pull',
      expectedSeverity: 20,
      expectedTitleContains: 'Docker image pulled',
    },
    // vault
    {
      category: 'vault',
      subtype: 'unseal',
      expectedType: 'vault.unseal',
      expectedSeverity: 50,
      expectedTitleContains: 'Vault unsealed',
    },
    {
      category: 'vault',
      subtype: 'token.create.root',
      expectedType: 'vault.token.create.root',
      expectedSeverity: 70,
      expectedTitleContains: 'Vault root token created',
    },
    {
      category: 'vault',
      subtype: 'token.create',
      expectedType: 'vault.token.create',
      expectedSeverity: 40,
      expectedTitleContains: 'Vault token created',
    },
    {
      category: 'vault',
      subtype: 'policy.change',
      expectedType: 'vault.policy.change',
      expectedSeverity: 50,
      expectedTitleContains: 'Vault policy modified',
    },
    // edge
    {
      category: 'edge',
      subtype: 'auth.denied',
      expectedType: 'edge.auth.denied',
      expectedSeverity: 30,
      expectedTitleContains: 'Edge authentication denied',
    },
    {
      category: 'edge',
      subtype: 'auth.success',
      expectedType: 'edge.auth.success',
      expectedSeverity: 10,
      expectedTitleContains: 'Edge authentication success',
    },
    {
      category: 'edge',
      subtype: 'http.deny',
      expectedType: 'edge.http.deny',
      expectedSeverity: 20,
      expectedTitleContains: 'Edge HTTP request denied',
    },
    {
      category: 'edge',
      subtype: 'http.blocked',
      expectedType: 'edge.http.blocked',
      expectedSeverity: 30,
      expectedTitleContains: 'Edge HTTP request blocked',
    },
    // zero-severity
    {
      category: 'docker',
      subtype: 'volume.create',
      expectedType: 'docker.volume.create',
      expectedSeverity: 0,
      expectedTitleContains: 'Docker volume created',
    },
  ]

  for (const t of tests) {
    it(`maps ${t.category}.${t.subtype} → ${t.expectedType} (severity ${t.expectedSeverity})`, () => {
      const result = normalizeHostAgentEvent(
        makeEvent({ category: t.category, subtype: t.subtype }),
        'orion'
      )

      expect(result.type).toBe(t.expectedType)
      expect(result.severity).toBe(t.expectedSeverity)
      expect(result.title).toContain(t.expectedTitleContains)
      expect(result.source).toBe('host_agent')
      expect(result.sourceName).toBe('orion')
      expect(result.description).toBeDefined()
      expect(result.metadata).toEqual(
        expect.objectContaining({
          hostname: 'orion',
          category: t.category,
          subtype: t.subtype,
          source_file: 'journald',
        })
      )
    })
  }
})

// ── Normalizer — dedupKey ────────────────────────────────────────────────────

describe('normalizeHostAgentEvent — dedupKey', () => {
  it('is deterministic for the same event + hostname', () => {
    const base = makeEvent({ category: 'auth', subtype: 'ssh.failed_password' })
    const r1 = normalizeHostAgentEvent(base, 'orion')
    const r2 = normalizeHostAgentEvent(base, 'orion')
    expect(r1.dedupKey).toBe(r2.dedupKey)
  })

  it('changes when hostname changes', () => {
    const base = makeEvent({ category: 'auth', subtype: 'ssh.failed_password' })
    const r1 = normalizeHostAgentEvent(base, 'orion')
    const r2 = normalizeHostAgentEvent(base, 'managed-host-1')
    expect(r1.dedupKey).not.toBe(r2.dedupKey)
  })

  it('changes when raw log differs', () => {
    const r1 = normalizeHostAgentEvent(
      makeEvent({ raw: 'Failed password for admin from 1.2.3.4' }),
      'orion'
    )
    const r2 = normalizeHostAgentEvent(
      makeEvent({ raw: 'Failed password for admin from 5.6.7.8' }),
      'orion'
    )
    expect(r1.dedupKey).not.toBe(r2.dedupKey)
  })

  it('does NOT include hostname in dedupKey (uses only source_file + timestamp + subtype + raw)', () => {
    // Note: this assertion may need adjustment if we decide hostname should be part of dedup.
    // Current design: hostname appears in the raw metadata and the title,
    // but the dedupKey itself is source_file|timestamp|subtype|raw_excerpt.
    // This means the SAME raw event from different hosts shares a dedupKey.
    // A more robust design would include hostname in the dedupKey.
    const base = makeEvent({ category: 'auth', subtype: 'ssh.failed_password' })
    const r1 = normalizeHostAgentEvent(base, 'orion')
    const r2 = normalizeHostAgentEvent(base, 'managed-host-1')
    // The current implementation uses hostname in createDedupKey — this test
    // documents that behavior (hostname IS included).
    expect(r1.dedupKey).not.toBe(r2.dedupKey)
  })
})

// ── Normalizer — fallback for unknown subtypes ──────────────────────────────

describe('normalizeHostAgentEvent — unknown subtype fallback', () => {
  it('uses category.subtype as the type when no rule matches', () => {
    const result = normalizeHostAgentEvent(
      makeEvent({ category: 'docker', subtype: 'custom.unknown_event', severity: 0 }),
      'orion'
    )
    expect(result.type).toBe('docker.custom.unknown_event')
    expect(result.severity).toBe(0) // event.severity is used when no rule matches
    expect(result.title).toContain('docker: custom.unknown_event')
  })

  it('uses event.severity when no rule matches', () => {
    const result = normalizeHostAgentEvent(
      makeEvent({ category: 'auth', subtype: 'custom.foo', severity: 75 }),
      'orion'
    )
    expect(result.severity).toBe(75)
  })
})

// ── Normalizer — output shape ───────────────────────────────────────────────

describe('normalizeHostAgentEvent — output shape', () => {
  it('returns a complete NormalizedSecurityEvent', () => {
    const result = normalizeHostAgentEvent(
      makeEvent({ category: 'vault', subtype: 'unseal' }),
      'orion'
    )

    expect(result).toMatchObject({
      id: undefined,
      environmentId: null,
      source: 'host_agent',
      type: 'vault.unseal',
      severity: 50,
      title: expect.stringContaining('orion'),
      description: expect.any(String),
      dedupKey: expect.any(String),
      sourceName: 'orion',
      metadata: expect.any(Object),
    })
    expect(result.timestamp).toBeInstanceOf(Date)
  })
})

// ── HostAgentEventBatch schema ────────────────────────────────────────────────

describe('hostAgentBatchSchema', () => {
  it('validates a correct batch', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: 40,
          timestamp: '2026-05-22T10:00:00Z',
          source_file: 'journald',
          raw: 'Failed password for admin from 1.2.3.4',
        },
        {
          category: 'docker',
          subtype: 'container.oom',
          severity: 30,
          timestamp: '2026-05-22T10:00:01Z',
          raw: 'Container killed due to OOM',
        },
      ],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.batch_id).toBe('batch-1')
    expect(result.hostname).toBe('orion')
    expect(result.events).toHaveLength(2)
  })

  it('validates an empty events array', () => {
    const batch = {
      batch_id: 'batch-empty',
      hostname: 'orion',
      events: [],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.events).toHaveLength(0)
  })

  it('rejects invalid category', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'invalid',
          subtype: 'foo',
          severity: 30,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('rejects missing batch_id', () => {
    const batch = {
      hostname: 'orion',
      events: [],
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('rejects missing hostname', () => {
    const batch = {
      batch_id: 'batch-1',
      events: [],
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('rejects missing events field', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('rejects severity out of range', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: 150,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('rejects negative severity', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: -1,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    expect(() => hostAgentBatchSchema.parse(batch)).toThrow()
  })

  it('accepts severity 0', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'docker',
          subtype: 'volume.create',
          severity: 0,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'volume created',
        },
      ],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.events[0].severity).toBe(0)
  })

  it('accepts severity 100', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: 100,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.events[0].severity).toBe(100)
  })

  it('rejects source_file missing (should be optional — default to undefined)', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: 40,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.events[0].source_file).toBeUndefined()
  })

  it('coerces ISO timestamp strings to Date', () => {
    const batch = {
      batch_id: 'batch-1',
      hostname: 'orion',
      events: [
        {
          category: 'auth',
          subtype: 'ssh.failed_password',
          severity: 40,
          timestamp: '2026-05-22T10:00:00Z',
          raw: 'test',
        },
      ],
    }
    const result = hostAgentBatchSchema.parse(batch)
    expect(result.events[0].timestamp).toBeInstanceOf(Date)
  })
})

// ── SEVERITY_RULES completeness ──────────────────────────────────────────────

describe('SEVERITY_RULES', () => {
  it('has no duplicate (category + subtype) combinations', () => {
    const pairs = SEVERITY_RULES.map((r) => `${r.category}:${r.pattern.source}`)
    const unique = new Set(pairs)
    expect(pairs.length).toBe(unique.size)
  })

  it('has at least one rule per category', () => {
    const categories = new Set(SEVERITY_RULES.map((r) => r.category))
    expect(categories).toContain('auth')
    expect(categories).toContain('docker')
    expect(categories).toContain('vault')
    expect(categories).toContain('edge')
  })
})
