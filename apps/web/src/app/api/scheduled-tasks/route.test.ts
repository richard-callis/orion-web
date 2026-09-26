/**
 * Tests for /api/scheduled-tasks ownership (SOC2 H4)
 *
 * Guards that:
 *  - creation requires a human session with write access and records createdBy
 *  - non-admins cannot schedule work for system agents or other users' agents
 *  - update/delete/trigger are limited to the owner or an admin
 *  - legacy rows with no owner are admin-only
 *  - triggered tasks are attributed to the schedule owner (Task.createdBy is an FK)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type User = { id: string; username: string; email: string; name: null; role: string; active: boolean }

const { scheduledTask, agent, task, jobRun, auth } = vi.hoisted(() => ({
  scheduledTask: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  agent: { findUnique: vi.fn() },
  task: { create: vi.fn() },
  jobRun: { create: vi.fn() },
  auth: { current: null as User | null },
}))

vi.mock('@/lib/db', () => ({ prisma: { scheduledTask, agent, task, jobRun } }))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => auth.current),
  requireServiceAuth: vi.fn(async () => {
    if (!auth.current) throw new Error('Unauthorized')
    return auth.current
  }),
  requireWriteAccess: vi.fn(async () => {
    if (!auth.current) throw new Error('Unauthorized')
    if (auth.current.role === 'readonly') throw new Error('Forbidden')
    return auth.current
  }),
}))

vi.mock('@/lib/seed-system-agents', () => ({
  SYSTEM_AGENT_DEFS: [{ nova: { displayName: 'Alpha' } }, { nova: { displayName: 'Warden' } }],
}))

import { POST as createSchedule } from './route'
import { PUT, DELETE } from './[id]/route'
import { POST as triggerSchedule } from './[id]/trigger/route'

const mk = (id: string, role: string): User => ({ id, username: id, email: '', name: null, role, active: true })
const owner = mk('user-owner', 'user')
const other = mk('user-other', 'user')
const readonly = mk('user-ro', 'readonly')
const admin = mk('user-admin', 'admin')

const params = { params: Promise.resolve({ id: 'sched-1' }) }

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://x/api/scheduled-tasks', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const createBody = { name: 'nightly', agentId: 'agent-1', cronExpr: '0 3 * * *', taskTitle: 'Do the thing' }
const schedule = (createdBy: string | null) => ({
  id: 'sched-1', name: 'nightly', agentId: 'agent-1', cronExpr: '0 3 * * *', taskTitle: 'Do the thing',
  taskDesc: null, taskMeta: null, enabled: true, nextRunAt: null, createdBy, agent: { id: 'agent-1' },
})

beforeEach(() => {
  auth.current = owner
  scheduledTask.findUnique.mockReset().mockResolvedValue(schedule(owner.id))
  scheduledTask.create.mockReset().mockImplementation(async ({ data }) => ({ id: 'sched-1', ...data }))
  scheduledTask.update.mockReset().mockImplementation(async ({ data }) => ({ id: 'sched-1', ...data }))
  scheduledTask.delete.mockReset().mockResolvedValue({})
  agent.findUnique.mockReset().mockImplementation(async ({ where }) => (
    where.id === 'agent-alpha' ? { id: 'agent-alpha', name: 'Alpha', createdBy: null }
      : where.id === 'agent-others' ? { id: 'agent-others', name: 'Theirs', createdBy: other.id }
      : { id: where.id, name: 'Worker', createdBy: null }
  ))
  task.create.mockReset().mockResolvedValue({ id: 'task-1' })
  jobRun.create.mockReset().mockResolvedValue({})
})

describe('POST /api/scheduled-tasks', () => {
  it('rejects unauthenticated callers (including gateway-token-only requests)', async () => {
    auth.current = null
    const res = await createSchedule(req('POST', createBody))
    expect(res.status).toBe(401)
  })

  it('rejects readonly users', async () => {
    auth.current = readonly
    const res = await createSchedule(req('POST', createBody))
    expect(res.status).toBe(403)
    expect(scheduledTask.create).not.toHaveBeenCalled()
  })

  it('records the creator as owner', async () => {
    const res = await createSchedule(req('POST', createBody))
    expect(res.status).toBe(201)
    expect(scheduledTask.create.mock.calls[0][0].data.createdBy).toBe(owner.id)
  })

  it('blocks non-admins from scheduling work for system agents', async () => {
    const res = await createSchedule(req('POST', { ...createBody, agentId: 'agent-alpha' }))
    expect(res.status).toBe(403)
  })

  it("blocks non-admins from scheduling work for another user's agent", async () => {
    const res = await createSchedule(req('POST', { ...createBody, agentId: 'agent-others' }))
    expect(res.status).toBe(403)
  })

  it('lets admins schedule system agents', async () => {
    auth.current = admin
    const res = await createSchedule(req('POST', { ...createBody, agentId: 'agent-alpha' }))
    expect(res.status).toBe(201)
  })
})

describe('PUT/DELETE/trigger /api/scheduled-tasks/[id]', () => {
  it("forbids another user from rewriting a schedule's instructions", async () => {
    auth.current = other
    const res = await PUT(req('PUT', { taskDesc: 'exfiltrate secrets' }), params)
    expect(res.status).toBe(403)
    expect(scheduledTask.update).not.toHaveBeenCalled()
  })

  it('lets the owner update their schedule', async () => {
    const res = await PUT(req('PUT', { enabled: false }), params)
    expect(res.status).toBe(200)
  })

  it('rejects a too-frequent cron on update', async () => {
    const res = await PUT(req('PUT', { cronExpr: '* * * * *' }), params)
    expect(res.status).toBe(400)
  })

  it('treats legacy ownerless schedules as admin-only', async () => {
    scheduledTask.findUnique.mockResolvedValue(schedule(null))
    const res = await DELETE(req('DELETE'), params)
    expect(res.status).toBe(403)

    auth.current = admin
    const res2 = await DELETE(req('DELETE'), params)
    expect(res2.status).toBe(200)
  })

  it('forbids another user from deleting or triggering', async () => {
    auth.current = other
    expect((await DELETE(req('DELETE'), params)).status).toBe(403)
    expect((await triggerSchedule(req('POST'), params)).status).toBe(403)
    expect(task.create).not.toHaveBeenCalled()
  })

  it('forbids readonly users even on schedules they created', async () => {
    auth.current = readonly
    scheduledTask.findUnique.mockResolvedValue(schedule(readonly.id))
    expect((await PUT(req('PUT', { enabled: false }), params)).status).toBe(403)
  })

  it('attributes triggered tasks to the schedule owner, never a non-user id', async () => {
    const res = await triggerSchedule(req('POST'), params)
    expect(res.status).toBe(200)
    expect(task.create.mock.calls[0][0].data.createdBy).toBe(owner.id)
  })
})
