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
import { getPlannerAgentId } from '@/lib/seed-system-agents'
import { triggerRoomAgentReplies } from '@/lib/room-agents'

// GET /api/chatrooms — list rooms
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') ?? undefined
  const featureId = searchParams.get('featureId') ?? undefined
  const epicId = searchParams.get('epicId') ?? undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50') || 50, 200)
  const cursor = searchParams.get('cursor')

  const where: Record<string, unknown> = {}
  if (type) where.type = type
  if (featureId) where.featureId = featureId
  if (epicId) where.epicId = epicId

  const rooms = await prisma.chatRoom.findMany({
    where,
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { messages: true, members: true } },
      task: { select: { id: true, title: true } },
      feature: { select: { id: true, title: true } },
      epic: { select: { id: true, title: true } },
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
  const epicId     = body.epicId ? String(body.epicId) : null

  const room = await prisma.chatRoom.create({
    data: {
      name:        String(body.name ?? ''),
      description: body.description ? String(body.description) : null,
      type:        body.type ? String(body.type) : 'task',
      taskId:      body.taskId ? String(body.taskId) : null,
      featureId,
      epicId,
      createdBy:   String(createdBy),
      // metadata is not a Prisma field on ChatRoom — store planTarget via description
      // or leave for caller to track. Feature/task relation covers structural linkage.
    },
    include: {
      _count: { select: { messages: true, members: true } },
      task:    { select: { id: true, title: true } },
      feature: { select: { id: true, title: true } },
      epic:    { select: { id: true, title: true } },
    },
  })

  const userId  = session?.user?.id ?? null
  const agentId = (body.agentId && String(body.agentId)) as string | null

  // Add the creator as a member
  await prisma.chatRoomMember.create({
    data: { roomId: room.id, userId, agentId, role: 'lead' },
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

  // ── Planning rooms: auto-add Planner + seed initial context ──────────────────
  if (room.type === 'planning') {
    const plannerId = await getPlannerAgentId()

    if (plannerId) {
      // Add Planner as a member (idempotent)
      await prisma.chatRoomMember.upsert({
        where:  { roomId_agentId: { roomId: room.id, agentId: plannerId } },
        update: {},
        create: { roomId: room.id, agentId: plannerId, role: 'lead' },
      })

      // Build context message so Planner knows what is being planned
      const context = await buildPlanningContext(room.epicId, room.featureId, room.taskId)

      // Post context as a system message — triggerRoomAgentReplies fires on
      // non-agent messages, so Planner will auto-reply with its opening plan
      await prisma.chatMessage.create({
        data: { roomId: room.id, senderType: 'system', content: context },
      })

      // Fire-and-forget — Planner replies asynchronously
      triggerRoomAgentReplies(room.id, context).catch(e =>
        console.error('[chatrooms] Planner auto-reply failed:', e instanceof Error ? e.message : e)
      )
    } else {
      // Planner not seeded yet — post plain creation message
      await prisma.chatMessage.create({
        data: {
          roomId:     room.id,
          senderType: 'system',
          content:    `Planning session started${planTarget ? ` for ${planTarget.type}` : ''}.`,
        },
      })
    }
  } else {
    await prisma.chatMessage.create({
      data: {
        roomId:     room.id,
        senderType: 'system',
        content:    `Room created by ${createdBy}${planTarget ? ` for ${planTarget.type} planning` : ''}`,
      },
    })
  }

  // Return both room and planTarget hint for caller routing
  return NextResponse.json({ ...room, planTarget: planTarget ?? null }, { status: 201 })
}

// ── Planning context builder ───────────────────────────────────────────────────

async function buildPlanningContext(
  epicId:    string | null,
  featureId: string | null,
  taskId:    string | null,
): Promise<string> {
  if (epicId) {
    const epic = await prisma.epic.findUnique({
      where:   { id: epicId },
      select:  { title: true, description: true },
    })
    if (!epic) return `Planning session for epic (id: ${epicId}).`
    return [
      `## Planning session — Epic: "${epic.title}"`,
      epic.description ? `\n**Description:** ${epic.description}` : '',
      `\nPlease help plan this epic. Present a comprehensive plan covering Goals, Scope, Key Features, Technical Approach, and Success Criteria.`,
    ].join('')
  }

  if (featureId) {
    const feature = await prisma.feature.findUnique({
      where:   { id: featureId },
      include: { epic: { select: { title: true, description: true, plan: true } } },
    })
    if (!feature) return `Planning session for feature (id: ${featureId}).`
    const lines = [
      `## Planning session — Feature: "${feature.title}"`,
      feature.description ? `\n**Description:** ${feature.description}` : '',
    ]
    if (feature.epic) {
      lines.push(`\n**Part of Epic:** ${feature.epic.title}`)
      if (feature.epic.plan) lines.push(`\n**Epic plan (for context):**\n${feature.epic.plan}`)
    }
    lines.push(`\nPlease help plan this feature. Present a detailed plan covering: What it does, Technical approach, Acceptance Criteria, and a numbered Task breakdown.`)
    return lines.join('')
  }

  if (taskId) {
    const task = await prisma.task.findUnique({
      where:   { id: taskId },
      include: {
        feature: {
          select: { title: true, plan: true, epic: { select: { title: true } } },
        },
      },
    })
    if (!task) return `Planning session for task (id: ${taskId}).`
    const lines = [
      `## Planning session — Task: "${task.title}"`,
      task.description ? `\n**Description:** ${task.description}` : '',
    ]
    if (task.feature) {
      lines.push(`\n**Part of Feature:** ${task.feature.title}`)
      if (task.feature.epic) lines.push(` (Epic: ${task.feature.epic.title})`)
      if (task.feature.plan) lines.push(`\n**Feature plan (for context):**\n${task.feature.plan}`)
    }
    lines.push(`\nPlease produce a numbered step-by-step implementation plan for this task. Each step should be specific enough for a smaller LLM to execute independently — include exact file paths, function names, and expected outputs.`)
    return lines.join('')
  }

  return `Planning session started. What would you like to plan?`
}
