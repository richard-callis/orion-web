/**
 * /api/chatrooms
 *
 * GET    — List chat rooms the current user is a member of
 * POST   — Create a new chat room
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

async function resolveUser(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey) return { userId: null, agentId: null }

  const session = await getServerSession(authOptions)
  if (session?.user?.id) return { userId: session.user.id, agentId: null }
  return { userId: null, agentId: null }
}

// GET /api/chatrooms — list rooms
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') ?? undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50') || 50, 200)
  const cursor = searchParams.get('cursor')

  const where: Record<string, unknown> = {}
  if (type) where.type = type

  const rooms = await prisma.chatRoom.findMany({
    where,
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { messages: true, members: true } },
      task: { select: { id: true, title: true } },
    },
  })

  // Filter to rooms user belongs to (or all if admin for now)
  const { userId } = await resolveUser(req)
  let result = rooms
  if (userId) {
    result = await Promise.all(rooms.map(async (room) => {
      const members = await prisma.chatRoomMember.findMany({
        where: { room_id: room.id },
        select: { user_id: true, agent_id: true },
      })
      const isMember = members.some(m => m.user_id === userId)
      return isMember ? {
        ...room,
        members: members.map(m => ({ agentId: m.agent_id, userId: m.user_id })),
      } : null
    }))
    result = result.filter(Boolean) as any
  }

  return NextResponse.json({ rooms: result })
}

// POST /api/chatrooms — create a room
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const session = await getServerSession(authOptions)
  const createdBy = session?.user?.id ?? body.createdBy ?? 'system'

  const room = await prisma.chatRoom.create({
    data: {
      name: String(body.name ?? ''),
      description: body.description ? String(body.description) : null,
      type: body.type ?? 'task',
      task_id: body.taskId ? String(body.taskId) : null,
      created_by: String(createdBy),
    },
    include: {
      _count: { select: { messages: true, members: true } },
      task: { select: { id: true, title: true } },
    },
  })

  // Auto-add creator as member
  const userId = session?.user?.id ?? null
  const agentId = (body.agentId && String(body.agentId)) || null
  await prisma.chatRoomMember.create({
    data: {
      room_id: room.id,
      user_id: userId,
      agent_id: agentId,
      role: 'lead',
    },
  })

  // System join message
  await prisma.chatMessage.create({
    data: {
      room_id: room.id,
      sender_type: 'system',
      content: `Room created by ${createdBy}`,
    },
  })

  return NextResponse.json(room, { status: 201 })
}
