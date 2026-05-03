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
import { triggerRoomAgentReplies } from '@/lib/room-agents'

async function getRoomMembership(roomId: string, userId: string | undefined) {
  const member = await prisma.chatRoomMember.findFirst({
    where: { roomId, userId },
    select: { userId: true, agentId: true },
  })
  return { userId: member?.userId ?? userId, agentId: member?.agentId ?? null }
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

  const where: Record<string, string> = { roomId: id }

  const messages = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      agent: { select: { id: true, name: true, type: true } },
      user: { select: { id: true, username: true, name: true } },
    },
  })

  const formatted = messages.reverse().map((msg: any) => ({
    id: msg.id,
    senderType: msg.senderType,
    content: msg.content,
    attachments: msg.attachments,
    sender: msg.agent ? { type: 'agent', id: msg.agent.id, name: msg.agent.name }
            : msg.user ? { type: 'user', id: msg.user.id, name: msg.user.name || msg.user.username }
            : { type: 'unknown', id: null, name: 'unknown' },
    createdAt: msg.createdAt.toISOString(),
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

  const taskId = body.taskId ? String(body.taskId) : undefined

  const msg = await prisma.chatMessage.create({
    data: {
      roomId: id,
      userId: memberUserId ?? userId,
      agentId,
      senderType: body.senderType ? String(body.senderType) : (agentId ? 'agent' : 'human'),
      content: content.trim(),
      attachments: (body.attachments as any) ?? undefined,
      taskId: taskId ?? null,
    },
    include: {
      agent: { select: { id: true, name: true } },
      user: { select: { id: true, username: true, name: true } },
    },
  })

  await prisma.chatRoom.update({
    where: { id },
    data: { updatedAt: new Date() },
  })

  // Fire agent replies asynchronously — don't block the HTTP response
  if (msg.senderType !== 'agent') {
    triggerRoomAgentReplies(id, content.trim()).catch(e =>
      console.error('[room-agents] trigger failed:', e instanceof Error ? e.message : e)
    )
  }

  return NextResponse.json({
    id: msg.id, senderType: msg.senderType, content: msg.content,
    attachments: msg.attachments,
    sender: msg.agent ? { type: 'agent', id: msg.agent.id, name: msg.agent.name }
            : msg.user ? { type: 'user', id: msg.user.id, name: msg.user.name || msg.user.username }
            : { type: 'unknown', id: null, name: 'system' },
    createdAt: msg.createdAt.toISOString(),
  }, { status: 201 })
}
