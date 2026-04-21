/**
 * /api/chatrooms/[id]/messages
 *
 * GET    — List messages in a room (paginated, newest first)
 * POST   — Send a message to a room
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

async function getRoomMembership(roomId: string, userId: string | undefined) {
  const member = await prisma.chatRoomMember.findFirst({
    where: { room_id: roomId, user_id: userId },
    select: { user_id: true, agent_id: true },
  })
  return { userId: member?.user_id ?? userId, agentId: member?.agent_id ?? null }
}

// GET /api/chatrooms/[id]/messages
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { searchParams } = new URL(_req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50') || 50, 200)
  const before = searchParams.get('before')

  const where: Record<string, string> = { room_id: id }

  const messages = await prisma.chatMessage.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: limit,
    include: {
      agent: { select: { id: true, name: true, type: true } },
      user: { select: { id: true, username: true, name: true } },
    },
  })

  const formatted = messages.reverse().map(msg => ({
    id: msg.id,
    sender_type: msg.sender_type,
    content: msg.content,
    attachments: msg.attachments,
    sender: msg.agent ? { type: 'agent', id: msg.agent.id, name: msg.agent.name }
            : msg.user ? { type: 'user', id: msg.user.id, name: msg.user.name || msg.user.username }
            : { type: 'unknown', id: null, name: 'unknown' },
    created_at: msg.created_at.toISOString(),
  }))

  return NextResponse.json({ messages: formatted })
}

// POST /api/chatrooms/[id]/messages
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  const { userId: memberUserId, agentId } = await getRoomMembership(id, userId)
  if (!memberUserId && !agentId) {
    return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 })
  }

  const content = String(body.content ?? '')
  if (!content.trim()) return NextResponse.json({ error: 'Message content required' }, { status: 400 })

  const msg = await prisma.chatMessage.create({
    data: {
      room_id: id,
      user_id: memberUserId ?? userId,
      agent_id: agentId,
      sender_type: body.senderType ?? (agentId ? 'agent' : 'human'),
      content: content.trim(),
      attachments: body.attachments ?? [],
    },
    include: {
      agent: { select: { id: true, name: true } },
      user: { select: { id: true, username: true, name: true } },
    },
  })

  await prisma.chatRoom.update({
    where: { id },
    data: { updated_at: new Date() },
  })

  return NextResponse.json({
    id: msg.id, sender_type: msg.sender_type, content: msg.content,
    attachments: msg.attachments,
    sender: msg.agent ? { type: 'agent', id: msg.agent.id, name: msg.agent.name }
            : msg.user ? { type: 'user', id: msg.user.id, name: msg.user.name || msg.user.username }
            : { type: 'unknown', id: null, name: 'system' },
    created_at: msg.created_at.toISOString(),
  }, { status: 201 })
}
