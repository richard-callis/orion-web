/**
 * H2: the executor's x-executor-token may post system notices only into the
 * configured execution room.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { prisma, requireServiceAuth } = vi.hoisted(() => ({
  prisma: {
    systemSetting: { findUnique: vi.fn() },
    chatMessage: { create: vi.fn() },
    chatRoom: { update: vi.fn() },
  },
  requireServiceAuth: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/room-agents', () => ({ triggerRoomAgentReplies: vi.fn(async () => {}) }))
vi.mock('@/lib/room-access', () => ({ getRoomMember: vi.fn(async () => null) }))
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>()
  return { ...actual, authOptions: {}, requireServiceAuth }
})

import { POST } from './route'

const EXECUTOR_TOKEN = 'executor-token-0123456789'

function post(roomId: string, headers: Record<string, string>) {
  return POST(
    new NextRequest(`http://x/api/chatrooms/${roomId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ content: 'EXECUTION REQUEST', senderType: 'system' }),
    }),
    { params: Promise.resolve({ id: roomId }) },
  )
}

beforeEach(() => {
  process.env.ORION_EXECUTOR_TOKEN = EXECUTOR_TOKEN
  prisma.systemSetting.findUnique.mockReset().mockResolvedValue({ key: 'system.room.execution', value: 'exec-room' })
  prisma.chatMessage.create.mockReset().mockImplementation(async ({ data }) => ({
    id: 'm1', ...data, agent: null, user: null, createdAt: new Date(),
  }))
  prisma.chatRoom.update.mockReset().mockResolvedValue({})
  requireServiceAuth.mockReset().mockRejectedValue(new Error('Unauthorized'))
})
afterEach(() => { delete process.env.ORION_EXECUTOR_TOKEN })

describe('POST /api/chatrooms/[id]/messages — executor token', () => {
  it('posts a system message into the execution room', async () => {
    const res = await post('exec-room', { 'x-executor-token': EXECUTOR_TOKEN })
    expect(res.status).toBe(201)
    expect(prisma.chatMessage.create.mock.calls[0][0].data).toMatchObject({ roomId: 'exec-room', senderType: 'system' })
  })

  it('refuses any other room', async () => {
    const res = await post('security-room', { 'x-executor-token': EXECUTOR_TOKEN })
    expect(res.status).toBe(403)
    expect(prisma.chatMessage.create).not.toHaveBeenCalled()
  })

  it('refuses when no execution room is configured', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null)
    const res = await post('exec-room', { 'x-executor-token': EXECUTOR_TOKEN })
    expect(res.status).toBe(403)
  })

  it('treats a wrong executor token as unauthenticated', async () => {
    const res = await post('exec-room', { 'x-executor-token': 'executor-token-WRONGWRONG' })
    expect(res.status).toBe(401)
    expect(prisma.chatMessage.create).not.toHaveBeenCalled()
  })
})
