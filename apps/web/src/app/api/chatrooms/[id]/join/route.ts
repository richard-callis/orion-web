/**
 * /api/chatrooms/[id]/join
 *
 * POST   — Join a chat room
 * DELETE — Leave a chat room
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

// POST /api/chatrooms/[id]/join — join room
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const agentId = body.agentId ? String(body.agentId) : null

  if (!userId && !agentId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const room = await prisma.chatRoom.findUnique({ where: { id } })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  await prisma.chatRoomMember.create({
    data: { room_id: id, user_id: userId, agent_id: agentId, role: body.role ?? 'member' },
  })

  const name = agentId ? `Agent ${agentId}` : session?.user?.username ?? userId
  await prisma.chatMessage.create({
    data: { room_id: id, sender_type: 'system', content: `${name} joined the room` },
  })

  return NextResponse.json({ joined: true })
}

// DELETE /api/chatrooms/[id]/join — leave room
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const room = await prisma.chatRoom.findUnique({ where: { id } })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  const member = await prisma.chatRoomMember.findFirst({
    where: { room_id: id, user_id: userId },
  })
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 404 })

  await prisma.chatRoomMember.delete({
    where: { room_id_agent_id_user_id: { room_id: id, user_id: userId } },
  })

  await prisma.chatMessage.create({
    data: { room_id: id, sender_type: 'system', content: `${session.user.username} left the room` },
  })

  return NextResponse.json({ left: true })
}
