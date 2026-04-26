/**
 * /api/chatrooms/[id]/invite
 *
 * POST — Invite a user or agent to a chat room (lead-only)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const userId = body.userId ? String(body.userId) : null
  const agentId = body.agentId ? String(body.agentId) : null

  if (!userId && !agentId) return NextResponse.json({ error: 'Provide userId or agentId' }, { status: 400 })

  const room = await prisma.chatRoom.findUnique({
    where: { id },
    include: { members: { select: { userId: true, agentId: true, role: true } } },
  })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  // Check if already a member
  const already = room.members.find((m: any) =>
    (userId && m.userId === userId) || (agentId && m.agentId === agentId)
  )
  if (already) return NextResponse.json({ error: 'Already a member' }, { status: 409 })

  // Any room member can invite
  const isMember = room.members.some((m: any) => m.userId === session.user.id)
  if (!isMember) {
    return NextResponse.json({ error: 'You must be a member of this room to invite others' }, { status: 403 })
  }

  const roleValue = typeof body.role === 'string' ? body.role : 'member'

  await prisma.chatRoomMember.create({
    data: { roomId: id, userId, agentId, role: roleValue },
  })

  const name = agentId
    ? (await prisma.agent.findUnique({ where: { id: agentId! }, select: { name: true } }))?.name || `Agent ${agentId}`
    : (await prisma.user.findUnique({ where: { id: userId! }, select: { username: true } }))?.username || userId

  await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: `${name} was added to the room` },
  })

  return NextResponse.json({ added: true })
}
