/**
 * GET /api/chatrooms — users only see rooms they are members of;
 * `?all=true` is honoured for admins only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { user, chatRoom } = vi.hoisted(() => ({
  user: { current: null as null | { id: string; role: string } },
  chatRoom: { findMany: vi.fn() },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }))
vi.mock('@/lib/auth', () => ({ authOptions: {}, getCurrentUser: vi.fn(async () => user.current) }))
vi.mock('@/lib/db', () => ({ prisma: { chatRoom } }))
vi.mock('@/lib/seed-system-agents', () => ({ getPlannerAgentId: vi.fn(), getEnvironmentSMEAgentId: vi.fn() }))
vi.mock('@/lib/room-agents', () => ({ triggerRoomAgentReplies: vi.fn() }))

import { GET } from './route'

const get = (qs = '') => GET(new NextRequest(`http://x/api/chatrooms${qs}`))
const whereOf = () => chatRoom.findMany.mock.calls[0][0].where

beforeEach(() => {
  user.current = { id: 'u1', role: 'user' }
  chatRoom.findMany.mockReset().mockResolvedValue([])
})

describe('GET /api/chatrooms', () => {
  it('requires a session', async () => {
    user.current = null
    expect((await get()).status).toBe(401)
  })

  it('scopes to the caller’s memberships', async () => {
    await get()
    expect(whereOf()).toEqual({ members: { some: { userId: 'u1' } } })
  })

  it('ignores all=true for non-admins (was: every user saw every room)', async () => {
    await get('?all=true')
    expect(whereOf()).toEqual({ members: { some: { userId: 'u1' } } })
  })

  it('honours all=true for admins', async () => {
    user.current = { id: 'a1', role: 'admin' }
    await get('?all=true')
    expect(whereOf()).toEqual({})
  })

  it('keeps other filters alongside membership', async () => {
    await get('?type=planning&epicId=e1')
    expect(whereOf()).toEqual({ type: 'planning', epicId: 'e1', members: { some: { userId: 'u1' } } })
  })
})
