/**
 * /api/chatrooms/[id]/goals/[goalId]
 *
 * PATCH — Complete or abandon a specific goal
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> }
) {
  const { id, goalId } = await params
  await getServerSession(authOptions)

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const status = typeof body.status === 'string' ? body.status : ''
  if (status !== 'completed' && status !== 'abandoned') {
    return NextResponse.json({ error: 'status must be "completed" or "abandoned"' }, { status: 400 })
  }
  const completionSummary = typeof body.completionSummary === 'string' ? body.completionSummary.trim() || null : null

  const goal = await prisma.roomGoal.findUnique({ where: { id: goalId } })
  if (!goal || goal.roomId !== id) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
  }

  const updated = await prisma.roomGoal.update({
    where: { id: goalId },
    data: { status, completionSummary, completedAt: new Date() },
  })

  const systemContent = status === 'completed'
    ? `✓ Goal completed${completionSummary ? `: ${completionSummary}` : ''}`
    : `✗ Goal abandoned${completionSummary ? `: ${completionSummary}` : ''}`

  const msg = await prisma.chatMessage.create({
    data: { roomId: id, senderType: 'system', content: systemContent },
  })

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

  return NextResponse.json({ goal: updated })
}
