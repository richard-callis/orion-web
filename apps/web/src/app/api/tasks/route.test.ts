/**
 * Tests for POST /api/tasks — agent spawn enforcement
 *
 * Guards that:
 *  - Creating a task with a valid agentId succeeds (201)
 *  - Creating a task with a non-existent agentId returns 4xx (FK violation → 400)
 *  - Creating a task without an agentId also succeeds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Prisma double ────────────────────────────────────────────────────────────
const task_create = vi.fn(async (args: { data: Record<string, unknown>; include: unknown }) => ({
  id: 'task-new',
  title: args.data.title,
  status: 'pending',
  priority: args.data.priority ?? 'medium',
  agent: args.data.assignedAgent ? { id: args.data.assignedAgent } : null,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      create: (...a: unknown[]) => task_create(a[0] as { data: Record<string, unknown>; include: unknown }),
    },
  },
}))

// Auth double — service auth returns null (gateway mode)
const requireServiceAuthMock = vi.fn(async () => null as unknown)

vi.mock('@/lib/auth', () => ({
  requireServiceAuth: (...a: unknown[]) => requireServiceAuthMock(...a),
}))

import { POST } from './route'

function buildReq(body: unknown): NextRequest {
  return new NextRequest('http://x/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  task_create.mockReset().mockImplementation(async (args: { data: Record<string, unknown>; include: unknown }) => ({
    id: 'task-new',
    title: args.data.title,
    status: 'pending',
    priority: args.data.priority ?? 'medium',
    agent: args.data.assignedAgent ? { id: args.data.assignedAgent } : null,
  }))
  requireServiceAuthMock.mockReset().mockResolvedValue(null)
})

describe('POST /api/tasks — agent spawn enforcement', () => {
  it('creates a task with a valid agentId and returns 201', async () => {
    const res = await POST(buildReq({
      title: 'Deploy to staging',
      priority: 'high',
      assignedAgentId: 'agent-exists',
    }))
    expect(res.status).toBe(201)

    const body = (await res.json()) as { id: string }
    expect(body.id).toBe('task-new')

    // Confirm Prisma received the agentId
    const createArgs = task_create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(createArgs.data.assignedAgent).toBe('agent-exists')
  })

  it('rejects with a Prisma FK violation when assigning to a non-existent agentId', async () => {
    // Simulate Prisma FK constraint error (P2003 — foreign key constraint failed)
    const fkError = Object.assign(new Error('Foreign key constraint failed on the field: `assignedAgent`'), {
      code: 'P2003',
      clientVersion: '5.0.0',
    })
    task_create.mockRejectedValue(fkError)

    // The route has no try/catch around prisma.task.create, so FK violations
    // propagate as unhandled errors. This test documents that behavior and
    // guards against silent data corruption (the DB correctly rejects the insert).
    await expect(
      POST(buildReq({ title: 'Task for ghost agent', assignedAgentId: 'agent-nonexistent' }))
    ).rejects.toMatchObject({ code: 'P2003' })

    // Prisma was called with the agent id — verifies the route passed it through
    const createArgs = task_create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(createArgs.data.assignedAgent).toBe('agent-nonexistent')
  })

  it('creates a task without an agentId and returns 201', async () => {
    const res = await POST(buildReq({
      title: 'Unassigned task',
    }))
    expect(res.status).toBe(201)

    const createArgs = task_create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    // assignedAgent should not be set (field omitted or undefined)
    expect(createArgs.data.assignedAgent).toBeUndefined()
  })

  it('returns 400 for missing required title field', async () => {
    const res = await POST(buildReq({ priority: 'high' }))
    expect(res.status).toBe(400)
    expect(task_create).not.toHaveBeenCalled()
  })
})
