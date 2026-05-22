/**
 * Tests for the SSE stream frame format.
 *
 * Covers R7 (SIEM_PLAN.md Risk Register): NOTIFY/SSE frames carry ID-only
 * payloads — never the full row. The consumer is expected to fetch the row
 * via the REST endpoints, where access control filters sensitive fields.
 *
 * If this test starts failing because the frame contains anything other than
 * { channel, payload: { id, type, timestamp } }, do NOT relax the test — the
 * regression is that frames are leaking row data to every subscriber.
 */

import { describe, it, expect } from 'vitest'
import { buildIdOnlyFrame } from './route'

describe('SSE stream — R7 ID-only frames', () => {
  it('frame contains only { channel, payload: { id, type, timestamp } }', () => {
    const frame = buildIdOnlyFrame('incidents', 'abc-123', 'created', '2026-01-01T00:00:00.000Z')
    expect(frame).toEqual({
      channel: 'incidents',
      payload: {
        id: 'abc-123',
        type: 'created',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    })
    // Defensive: no extra keys leaked into payload (R7)
    expect(Object.keys(frame.payload).sort()).toEqual(['id', 'timestamp', 'type'])
  })

  it('does not embed row data fields like attackerKey, payload, rawEvent', () => {
    const frame = buildIdOnlyFrame('approvals', 'audit-xyz')
    const stringified = JSON.stringify(frame)
    // These are all sensitive fields that previously leaked through SSE.
    expect(stringified).not.toContain('attackerKey')
    expect(stringified).not.toContain('rawEvent')
    expect(stringified).not.toContain('rootCauseSummary')
    expect(stringified).not.toContain('hostKey')
    // The audit payload column itself
    expect(frame.payload).not.toHaveProperty('actionType')
    expect(frame.payload).not.toHaveProperty('target')
  })

  it('serializes to compact JSON well under the 8KB NOTIFY limit', () => {
    const frame = buildIdOnlyFrame('events', 'a'.repeat(36))
    const wire = JSON.stringify(frame)
    expect(wire.length).toBeLessThan(256) // sanity, far below 8192
  })

  it('defaults type to created and timestamp to a valid ISO string', () => {
    const frame = buildIdOnlyFrame('events', 'evt-1')
    expect(frame.payload.type).toBe('created')
    expect(() => new Date(frame.payload.timestamp).toISOString()).not.toThrow()
    expect(new Date(frame.payload.timestamp).toISOString()).toBe(frame.payload.timestamp)
  })
})
