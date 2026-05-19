/**
 * /api/chatrooms/[id]/goals
 *
 * GET  — Return all goals for the room ordered by createdAt desc
 * POST — Create a new active goal (abandons any existing active goal first)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const room = await prisma.chatRoom.findUnique({ where: { id }, select: { id: true } })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  const goals = await prisma.roomGoal.findMany({
    where: { roomId: id },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ goals })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })

  const room = await prisma.chatRoom.findUnique({ where: { id }, select: { id: true } })
  if (!room) return NextResponse.json({ error: 'Chat room not found' }, { status: 404 })

  // Abandon any existing active goal
  await prisma.roomGoal.updateMany({
    where: { roomId: id, status: 'active' },
    data: { status: 'abandoned', completedAt: new Date() },
  })

  // Create new goal
  const goal = await prisma.roomGoal.create({
    data: {
      roomId: id,
      text,
      status: 'active',
      setBy: userId ?? null,
    },
  })

  // Post system message and store its ID on the goal
  const msg = await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: `🎯 Goal set: ${text}` },
  })

  const goalWithMsg = await prisma.roomGoal.update({
    where: { id: goal.id },
    data: { startMessageId: msg.id },
  })

  // Publish via Redis SSE so UI updates in real-time
  try {
    const { publishChatMessage } = await import('@/lib/chat-redis')
    await publishChatMessage(id, {
      id: msg.id,
      senderType: 'system',
      content: msg.content,
      attachments: null,
      sender: { type: 'system', id: null, name: 'System' },
      createdAt: msg.createdAt.toISOString(),
    })
  } catch { /* redis optional */ }

  return NextResponse.json({ goal: goalWithMsg }, { status: 201 })
}
