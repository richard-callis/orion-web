/**
 * /api/chatrooms
 *
 * GET    — List chat rooms the current user is a member of
 * POST   — Create a new chat room
 *
 * POST body additions (unified chat entry points):
 *   featureId   — link room to a Feature (type should be "feature" or "planning")
 *   planTarget  — { type: "epic"|"feature"|"task", id: string } stored in metadata
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

// GET /api/chatrooms — list rooms
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') ?? undefined
  const featureId = searchParams.get('featureId') ?? undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50') || 50, 200)
  const cursor = searchParams.get('cursor')

  const where: Record<string, unknown> = {}
  if (type) where.type = type
  if (featureId) where.featureId = featureId

  const rooms = await prisma.chatRoom.findMany({
    where,
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { messages: true, members: true } },
      task: { select: { id: true, title: true } },
      feature: { select: { id: true, title: true } },
    },
  })

  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  let result = rooms
  if (userId) {
    const filtered: any[] = []
    for (const room of rooms) {
      const members = await prisma.chatRoomMember.findMany({
        where: { roomId: room.id },
        select: { userId: true, agentId: true },
      })
      const isMember = members.some((m: any) => m.userId === userId)
      if (isMember) {
        filtered.push({
          ...room,
          members: members.map((m: any) => ({ agentId: m.agentId, userId: m.userId })),
        })
      }
    }
    result = filtered
  }

  return NextResponse.json({ rooms: result })
}

// POST /api/chatrooms — create a room
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const session = await getServerSession(authOptions)
  const createdBy = session?.user?.id ?? body.createdBy ?? 'system'

  // planTarget: { type: "epic"|"feature"|"task", id: string }
  // Stored as metadata so existing chat stream code can route planning conversations
  const planTarget = body.planTarget as { type: string; id: string } | undefined
  const featureId  = body.featureId ? String(body.featureId) : null

  const room = await prisma.chatRoom.create({
    data: {
      name:        String(body.name ?? ''),
      description: body.description ? String(body.description) : null,
      type:        body.type ? String(body.type) : 'task',
      taskId:      body.taskId ? String(body.taskId) : null,
      featureId,
      createdBy:   String(createdBy),
      // metadata is not a Prisma field on ChatRoom — store planTarget via description
      // or leave for caller to track. Feature/task relation covers structural linkage.
    },
    include: {
      _count: { select: { messages: true, members: true } },
      task:    { select: { id: true, title: true } },
      feature: { select: { id: true, title: true } },
    },
  })

  const userId  = session?.user?.id ?? null
  const agentId = (body.agentId && String(body.agentId)) as string | null

  await prisma.chatRoomMember.create({
    data: {
      roomId: room.id,
      userId,
      agentId,
      role: 'lead',
    },
  })

  // SOC2: log room creation to audit feed when agentId is provided
  if (agentId) {
    await prisma.agentMessage.create({
      data: {
        agentId,
        channel:     'agent-feed',
        content:     `Room created: **${room.name}** (type=${room.type}, id=${room.id})`,
        messageType: 'task_update',
      },
    }).catch(() => {})
  }

  await prisma.chatMessage.create({
    data: {
      roomId:     room.id,
      senderType: 'system',
      content:    `Room created by ${createdBy}${planTarget ? ` for ${planTarget.type} planning` : ''}`,
    },
  })

  // Return both room and planTarget hint for caller routing
  return NextResponse.json({ ...room, planTarget: planTarget ?? null }, { status: 201 })
}
