/**
 * /api/chatrooms/[id]/members
 *
 * GET    — List available users/agents that are NOT yet members (for invite dropdown)
 * DELETE — Remove (kick) a member by agentId or userId query param
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const room = await prisma.chatRoom.findUnique({
    where: { id },
    include: { members: { select: { userId: true, agentId: true } } },
  })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  // Get all users except the current user
  const allUsers = await prisma.user.findMany({
    select: { id: true, username: true, name: true },
    orderBy: { username: 'asc' },
    take: 500,
  })
  const allAgents = await prisma.agent.findMany({
    select: { id: true, name: true, type: true, metadata: true },
    orderBy: { name: 'asc' },
    take: 500,
  })

  const memberUserIds = room.members.map((m: any) => m.userId).filter(Boolean) as string[]
  const memberAgentIds = room.members.map((m: any) => m.agentId).filter(Boolean) as string[]

  const availableUsers = allUsers.filter((u: any) => u.id !== session.user.id && !memberUserIds.includes(u.id))
  const availableAgents = allAgents.filter((a: any) => {
    if (memberAgentIds.includes(a.id)) return false
    if ((a.metadata as Record<string, unknown> | null)?.archived === true) return false
    return true
  }).map(({ metadata: _m, ...rest }: any) => rest)

  return NextResponse.json({ users: availableUsers, agents: availableAgents })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  const userId = searchParams.get('userId')

  if (!agentId && !userId) return NextResponse.json({ error: 'Provide agentId or userId' }, { status: 400 })

  const room = await prisma.chatRoom.findUnique({
    where: { id },
    include: { members: { select: { id: true, userId: true, agentId: true, role: true } } },
  })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  // Caller must be a member of the room
  const callerMember = room.members.find((m: any) => m.userId === session.user.id)
  if (!callerMember) return NextResponse.json({ error: 'You are not a member of this room' }, { status: 403 })

  // Can't kick yourself via this endpoint — use /join DELETE for that
  if (userId && userId === session.user.id) {
    return NextResponse.json({ error: 'Use the leave endpoint to remove yourself' }, { status: 400 })
  }

  const target = room.members.find((m: any) =>
    (agentId && m.agentId === agentId) || (userId && m.userId === userId)
  )
  if (!target) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  await prisma.chatRoomMember.delete({ where: { id: target.id } })

  // If the kicked agent was the ring leader, clear it from room metadata
  if (agentId) {
    const meta = (room.metadata ?? {}) as Record<string, unknown>
    if (meta.ringLeaderAgentId === agentId) {
      const { ringLeaderAgentId: _, ...rest } = meta
      await prisma.chatRoom.update({ where: { id }, data: { metadata: rest as Prisma.InputJsonValue } })
    }
  }

  const displayName = agentId
    ? (await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } }))?.name ?? `Agent ${agentId}`
    : (await prisma.user.findUnique({ where: { id: userId! }, select: { username: true } }))?.username ?? userId

  await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: `${displayName} was removed from the room` },
  })

  return NextResponse.json({ removed: true })
}
