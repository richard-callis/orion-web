/**
 * /api/chatrooms/[id]/members
 *
 * GET — List available users/agents that are NOT yet members (for invite dropdown)
 */
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

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
  })
  const allAgents = await prisma.agent.findMany({
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  })

  const memberUserIds = room.members.map(m => m.userId).filter(Boolean) as string[]
  const memberAgentIds = room.members.map(m => m.agentId).filter(Boolean) as string[]

  const availableUsers = allUsers.filter(u => u.id !== session.user.id && !memberUserIds.includes(u.id))
  const availableAgents = allAgents.filter(a => !memberAgentIds.includes(a.id))

  return NextResponse.json({ users: availableUsers, agents: availableAgents })
}
