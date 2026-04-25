/**
 * /api/chatrooms/[id]
 *
 * GET    — Get a specific chat room with members and recent messages
 * PATCH  — Update room name/description
 * DELETE — Delete a chat room
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

// GET /api/chatrooms/[id]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { searchParams } = new URL(_req.url)
  const messageLimit = Math.min(parseInt(searchParams.get('messages') ?? '50') || 50, 200)

  const room = await prisma.chatRoom.findUnique({
    where: { id },
    include: {
      members: {
        select: {
          agentId: true, userId: true, role: true,
          joinedAt: true, lastReadAt: true,
          agent: { select: { id: true, name: true, type: true } },
          user: { select: { id: true, username: true, name: true } },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: messageLimit,
        include: {
          agent: { select: { id: true, name: true } },
          user: { select: { id: true, username: true, name: true } },
        },
      },
      task: { select: { id: true, title: true } },
    },
  })

  if (!room) {
    return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })
  }

  const messages = (room as any).messages.reverse().map((msg: any) => ({
    id: msg.id,
    senderType: msg.senderType,
    content: msg.content,
    attachments: msg.attachments,
    sender: msg.agent
      ? { type: 'agent', id: msg.agent.id, name: msg.agent.name }
      : msg.user
      ? { type: 'user', id: msg.user.id, name: msg.user.name || msg.user.username }
      : { type: msg.senderType ?? 'unknown', id: null, name: 'System' },
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
  }))
  const members = (room as any).members

  return NextResponse.json({
    id: room.id, name: room.name, description: room.description,
    type: room.type, task: room.task, createdBy: room.createdBy,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    members, messages,
  })
}

// PATCH /api/chatrooms/[id]
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  const room = await prisma.chatRoom.findUnique({
    where: { id },
    include: { members: { where: { userId: userId } } },
  })

  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  const creatorRole = room.members.find(m => m.userId === userId)?.role
  if (creatorRole !== 'lead' && room.createdBy !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updated = await prisma.chatRoom.update({
    where: { id },
    data: {
      name: body.name ? String(body.name) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
    },
  })

  await prisma.chatMessage.create({
    data: { roomId: room.id, senderType: 'system', content: `Room renamed to "${updated.name}"` },
  })

  return NextResponse.json({ id: updated.id, name: updated.name, description: updated.description, updatedAt: updated.updatedAt.toISOString() })
}

// DELETE /api/chatrooms/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  const room = await prisma.chatRoom.findUnique({ where: { id } })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })
  if (room.createdBy !== userId) return NextResponse.json({ error: 'Only the creator can delete a room' }, { status: 403 })

  await prisma.chatRoom.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}
