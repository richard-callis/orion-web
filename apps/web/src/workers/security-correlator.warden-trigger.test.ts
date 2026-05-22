/**
 * Tests for the security correlator's Warden-notice path.
 *
 * Locks in BUG-2 (#408 follow-up): the correlator must call
 * triggerRoomAgentReplies() after writing the "New Incident" ChatMessage so
 * Warden's agent actually wakes on a new incident. Every other ChatMessage
 * producer in the codebase (the HTTP message routes) makes this call; the
 * correlator was the only path that did not, leaving Warden silent.
 *
 * Regression guard: if you see this test failing because
 * triggerRoomAgentReplies was not called, the correlator has lost the trigger
 * again — do NOT relax this expectation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Prisma double ────────────────────────────────────────────────────────────
const env_findMany = vi.fn(async () => [] as unknown[])
const event_findMany = vi.fn(async () => [] as unknown[])
const event_updateMany = vi.fn(async () => ({ count: 0 }))
const incident_findMany = vi.fn(async () => [] as unknown[])
const incident_create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'inc-1',
  rootCauseSummary: 'brute force',
  severity: 80,
  attackerKey: '1.2.3.4',
  ...args.data,
}))
const chatMessage_create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'msg-1',
  ...args.data,
}))
const sourceHealth_findMany = vi.fn(async () => [] as unknown[])

vi.mock('@/lib/db', () => ({
  prisma: {
    environment: { findMany: (...a: unknown[]) => env_findMany(...a) },
    securityEvent: {
      findMany: (...a: unknown[]) => event_findMany(...a),
      updateMany: (...a: unknown[]) => event_updateMany(...a),
      create: async (args: { data: unknown }) => args.data,
    },
    incident: {
      findMany: (...a: unknown[]) => incident_findMany(...a),
      create: (...a: unknown[]) => incident_create(a[0] as { data: Record<string, unknown> }),
    },
    chatMessage: {
      create: (...a: unknown[]) => chatMessage_create(a[0] as { data: Record<string, unknown> }),
    },
    sourceHealth: {
      findMany: (...a: unknown[]) => sourceHealth_findMany(...a),
      update: async () => ({}),
    },
  },
}))

// rule-engine: return one draft per environment so the incident-create branch
// runs (and with it the Warden-notice + agent-trigger block).
vi.mock('@/lib/security/rule-engine', () => ({
  correlateEvents: vi.fn(async (envId: string) => [
    {
      ruleName: 'brute_force',
      severity: 80,
      rootCauseSummary: 'brute force',
      attackerKey: '1.2.3.4',
      hostKey: null,
      eventIds: ['evt-1'],
      environmentId: envId,
    },
  ]),
}))

vi.mock('@/lib/seed-system-epic', () => ({
  getSystemRoomId: vi.fn(async (key: string) =>
    key === 'system.room.security' ? 'security-room-id' : null,
  ),
}))

// The unit under test: triggerRoomAgentReplies must be invoked after the
// correlator writes the "New Incident" ChatMessage. We mock it so the test
// stays in-memory and does not spin up the agent runner.
const triggerRoomAgentRepliesMock = vi.fn(async () => undefined)
vi.mock('@/lib/room-agents', () => ({
  triggerRoomAgentReplies: (...a: unknown[]) => triggerRoomAgentRepliesMock(...a),
}))

import { runCorrelator } from './security-correlator'

beforeEach(() => {
  env_findMany.mockClear().mockResolvedValue([
    {
      id: 'env-1',
      correlationRules: [
        { name: 'brute_force', params: {}, severity: 80 },
      ],
    },
  ])
  event_findMany.mockClear().mockResolvedValue([
    { id: 'evt-1', environmentId: 'env-1' },
  ])
  event_updateMany.mockClear().mockResolvedValue({ count: 1 })
  incident_findMany.mockClear().mockResolvedValue([])
  incident_create.mockClear()
  chatMessage_create.mockClear()
  sourceHealth_findMany.mockClear().mockResolvedValue([])
  triggerRoomAgentRepliesMock.mockClear().mockResolvedValue(undefined)
})

describe('runCorrelator — triggers room agent replies on new incident (BUG-2)', () => {
  it('calls triggerRoomAgentReplies once with the security room id and notice body', async () => {
    await runCorrelator()

    // The Warden-notice ChatMessage must have been written first.
    expect(chatMessage_create).toHaveBeenCalledTimes(1)
    const msgArgs = chatMessage_create.mock.calls[0]?.[0]?.data as Record<string, unknown>
    expect(msgArgs.roomId).toBe('security-room-id')
    expect(typeof msgArgs.content).toBe('string')

    // And the agent trigger must have followed it.
    expect(triggerRoomAgentRepliesMock).toHaveBeenCalledTimes(1)
    expect(triggerRoomAgentRepliesMock).toHaveBeenCalledWith(
      'security-room-id',
      msgArgs.content,
    )
  })

  it('does NOT fail the correlation cycle if triggerRoomAgentReplies throws', async () => {
    triggerRoomAgentRepliesMock.mockRejectedValueOnce(new Error('agent runner down'))

    const results = await runCorrelator()

    // Fire-and-forget: incident was created, message was written, and the
    // correlator returned a 'correlated' status despite the trigger failing.
    expect(incident_create).toHaveBeenCalledTimes(1)
    expect(chatMessage_create).toHaveBeenCalledTimes(1)
    expect(results[0]?.status).toBe('correlated')

    // Give the unhandled promise a turn to settle so the test runner's
    // unhandled-rejection guard doesn't flag the inner .catch handler.
    await new Promise(resolve => setImmediate(resolve))
  })
})
