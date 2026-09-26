/**
 * GET /api/chatrooms/[id]/typing — membership required (SOC2 L7)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { session, member } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string } } },
  member: { findFirst: vi.fn() },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session.current) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/db', () => ({ prisma: { chatRoomMember: member } }))
vi.mock('@/lib/typing-state', () => ({ getTyping: () => ['Alpha'] }))

import { GET } from './route'

const call = () => GET(new NextRequest('http://x/api/chatrooms/room-1/typing'), { params: Promise.resolve({ id: 'room-1' }) })

beforeEach(() => {
  session.current = { user: { id: 'u1' } }
  member.findFirst.mockReset().mockResolvedValue(null)
})

describe('typing route', () => {
  it('requires a session', async () => {
    session.current = null
    expect((await call()).status).toBe(401)
  })

  it('forbids non-members', async () => {
    expect((await call()).status).toBe(403)
  })

  it('returns typing state to members', async () => {
    member.findFirst.mockResolvedValue({ userId: 'u1', agentId: null })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ typing: ['Alpha'] })
    expect(member.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: 'room-1', userId: 'u1' } }))
  })
})
