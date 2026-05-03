/**
 * /api/tasks/[id]/chat
 *
 * GET — Fetch the feature chat room for a task, filtered to messages tagged to this task.
 *       Also returns the roomId so the UI can link directly to the full feature room.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const task = await prisma.task.findUnique({
    where: { id: params.id },
    select: { feature: { select: { id: true } } },
  })

  const featureId = task?.feature?.id
  if (!featureId) return NextResponse.json({ rooms: [] })

  const rooms = await prisma.chatRoom.findMany({
    where: { featureId },
    orderBy: { createdAt: 'asc' },
    include: {
      messages: {
        where: { taskId: params.id },
        orderBy: { createdAt: 'asc' },
        include: {
          agent: { select: { id: true, name: true, type: true } },
          user: { select: { id: true, username: true, name: true } },
        },
      },
      members: {
        include: {
          agent: { select: { id: true, name: true } },
          user: { select: { id: true, username: true, name: true } },
        },
      },
    },
  })

  const formatted = (rooms as any[]).map(room => ({
    id: room.id,
    name: room.name,
    type: room.type,
    messages: room.messages.map((msg: any) => ({
      id: msg.id,
      senderType: msg.senderType,
      content: msg.content,
      attachments: msg.attachments,
      sender: msg.agent
        ? { type: 'agent' as const, id: msg.agent.id, name: msg.agent.name }
        : msg.user
          ? { type: 'user' as const, id: msg.user.id, name: msg.user.name || msg.user.username }
          : { type: 'system' as const, id: null, name: 'system' },
      createdAt: msg.createdAt.toISOString(),
    })),
    members: (room.members as any[]).map((m: any) => ({
      agentId: m.agentId,
      userId: m.userId,
      agent: m.agent ? { id: m.agent.id, name: m.agent.name } : null,
      user: m.user ? { id: m.user.id, name: m.user.name || m.user.username } : null,
    })),
  }))

  return NextResponse.json({ rooms: formatted })
}
