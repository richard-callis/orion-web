import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

// POST /api/agents/:id/chat
// Find or create a "direct" ChatRoom between the current user and this agent.
// Returns { roomId } so the caller can navigate to /messages?r=<roomId>.
// The Conversation model is no longer used for new chats (SOC2: attribution via ChatRoomMember).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const agent = await prisma.agent.findUnique({ where: { id: params.id } })
  if (!agent) return new NextResponse(null, { status: 404 })

  const session = await getServerSession(authOptions)
  const userId = session?.user?.id ?? null

  // Find existing direct room for this user ↔ agent pair
  let existingRoomId: string | null = null
  if (userId) {
    const candidateRooms = await prisma.chatRoom.findMany({
      where: { type: 'direct' },
      include: { members: { select: { userId: true, agentId: true } } },
    })
    for (const room of candidateRooms) {
      const hasUser  = room.members.some((m: { userId: string | null; agentId: string | null }) => m.userId === userId)
      const hasAgent = room.members.some((m: { userId: string | null; agentId: string | null }) => m.agentId === agent.id)
      if (hasUser && hasAgent) { existingRoomId = room.id; break }
    }
  }

  if (existingRoomId) {
    return NextResponse.json({ roomId: existingRoomId }, { status: 200 })
  }

  // Create the room
  const room = await prisma.chatRoom.create({
    data: {
      name:      `Chat: ${agent.name}`,
      type:      'direct',
      createdBy: userId ?? agent.id,
    },
  })

  // SOC2: log room creation to audit feed
  await prisma.agentMessage.create({
    data: {
      agentId:     agent.id,
      channel:     'agent-feed',
      content:     `Direct room created: **${room.name}** (${room.id})`,
      messageType: 'task_update',
    },
  }).catch(() => {})

  // Add both as members
  await Promise.all([
    prisma.chatRoomMember.create({
      data: { roomId: room.id, agentId: agent.id, role: 'member' },
    }),
    ...(userId ? [prisma.chatRoomMember.create({
      data: { roomId: room.id, userId, role: 'lead' },
    })] : []),
  ])

  // Welcome message (system, attributed)
  await prisma.chatMessage.create({
    data: {
      roomId:     room.id,
      agentId:    agent.id,
      senderType: 'system',
      content:    `Direct chat started with ${agent.name}.`,
    },
  }).catch(() => {})

  return NextResponse.json({ roomId: room.id }, { status: 201 })
}
