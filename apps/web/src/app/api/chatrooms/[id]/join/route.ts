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

  const role = body.role ? String(body.role) : 'member'
  await prisma.chatRoomMember.create({
    data: { roomId: id, userId, agentId, role },
  })

  const name = agentId ? `Agent ${agentId}` : session?.user?.username ?? userId
  await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: `${name} joined the room` },
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
    where: { roomId: id, userId },
  })
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 404 })

  await prisma.chatRoomMember.delete({ where: { id: member.id } })

  await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: `${session.user.username} left the room` },
  })

  return NextResponse.json({ left: true })
}
