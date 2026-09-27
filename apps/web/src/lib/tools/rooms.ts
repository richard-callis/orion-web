/**
 * Chat room tools: list rooms, post messages, set and complete room goals.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { auditLog, parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const ListRoomsArgs = z.object({
  feature_id: z.string().nullish(),
})

async function handleListRooms(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { feature_id } = parseToolArgs(ListRoomsArgs, args)

  const where: Record<string, unknown> = {}
  if (feature_id) where.featureId = feature_id

  const rooms = await ctx.prisma.chatRoom.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: {
      _count: { select: { members: true } },
    },
  })

  return JSON.stringify(
    rooms.map((r) => ({
      id:          r.id,
      name:        r.name,
      type:        r.type,
      featureId:   r.featureId ?? null,
      taskId:      r.taskId ?? null,
      memberCount: r._count.members,
      createdAt:   r.createdAt,
    })),
    null, 2
  )
}

const SendMessageArgs = z.object({
  room_id: z.string().nullish(),
  content: z.string().nullish(),
})

async function handleSendMessage(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, content } = parseToolArgs(SendMessageArgs, args)
  if (!room_id)  return 'Error: room_id is required'
  if (!content?.trim()) return 'Error: content is required'

  const actorId = ctx.agentId
  if (!actorId) return 'Error: actorId is required to send messages (SOC2 attribution)'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id }, select: { name: true } })
  if (!room) return `Error: room ${room_id} not found`

  const membership = await ctx.prisma.chatRoomMember.findUnique({
    where: { roomId_agentId: { roomId: room_id, agentId: actorId } },
  })
  if (!membership) return `Error: you are not a member of room "${room.name}" — agents may only send messages to rooms they belong to`

  await ctx.prisma.chatMessage.create({
    data: {
      roomId:     room_id,
      agentId:    actorId,
      senderType: 'agent',
      content:    content.trim(),
    },
  })

  await auditLog(actorId, `💬 Sent message to room **${room.name}** (${room_id})`)
  return `Message posted to room "${room.name}" (${room_id})`
}

const SetGoalArgs = z.object({
  room_id: z.string().nullish(),
  goal: z.string().nullish(),
})

async function handleSetGoal(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, goal } = parseToolArgs(SetGoalArgs, args)
  if (!room_id) return 'Error: room_id is required'
  if (!goal?.trim()) return 'Error: goal is required'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id } })
  if (!room) return `Error: room ${room_id} not found`

  // Abandon any existing active goal
  await ctx.prisma.roomGoal.updateMany({
    where: { roomId: room_id, status: 'active' },
    data: { status: 'abandoned', completedAt: new Date() },
  })

  // Create new goal record
  const newGoal = await ctx.prisma.roomGoal.create({
    data: {
      roomId: room_id,
      text: goal.trim(),
      status: 'active',
      setBy: ctx.agentId ?? ctx.userId ?? null,
    },
  })

  // Post system message and capture its ID
  const msg = await ctx.prisma.chatMessage.create({
    data: { roomId: room_id, senderType: 'system', content: `🎯 Goal set: ${goal.trim()}` },
  })
  await ctx.prisma.roomGoal.update({
    where: { id: newGoal.id },
    data: { startMessageId: msg.id },
  })

  return `Goal set in room "${room.name}": ${goal.trim()}`
}

const CompleteGoalArgs = z.object({
  room_id: z.string().nullish(),
  verification_summary: z.string().nullish(),
})

async function handleCompleteGoal(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { room_id, verification_summary } = parseToolArgs(CompleteGoalArgs, args)
  if (!room_id) return 'Error: room_id is required'
  if (!verification_summary?.trim()) return 'Error: verification_summary is required — describe what you actually checked to confirm the goal is complete (pod status, endpoint tests, etc.)'
  // Reject summaries that are too vague to be meaningful
  if (verification_summary.trim().length < 20) return 'Error: verification_summary is too vague — describe the specific checks you ran and what they showed'

  const room = await ctx.prisma.chatRoom.findUnique({ where: { id: room_id } })
  if (!room) return `Error: room ${room_id} not found`

  const activeGoalRecord = await ctx.prisma.roomGoal.findFirst({
    where: { roomId: room_id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (!activeGoalRecord) return `Error: no active goal found in room ${room_id}`

  await ctx.prisma.roomGoal.update({
    where: { id: activeGoalRecord.id },
    data: {
      status: 'completed',
      completionSummary: verification_summary.trim(),
      completedAt: new Date(),
    },
  })

  await ctx.prisma.chatMessage.create({
    data: { roomId: room_id, senderType: 'system', content: `✓ Goal completed: ${verification_summary.trim()}` },
  })

  if (ctx.agentId) await auditLog(ctx.agentId, `✅ Goal complete in room **${room.name}**: ${activeGoalRecord.text} — Verification: ${verification_summary.trim()}`)
  return `Goal "${activeGoalRecord.text}" marked complete. Verification: ${verification_summary.trim()}`
}

export const orionListRoomsTool: ToolDefinition = {
  name: 'orion_list_rooms',
  description: 'List chat rooms. Optionally filter by feature_id to find the coordination room for a feature.',
  inputSchema: {
    type: 'object',
    properties: {
      feature_id: { type: 'string', description: 'Filter by feature ID to find the feature coordination room' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'rooms',
  handler: handleListRooms,
}

export const orionSendMessageTool: ToolDefinition = {
  name: 'orion_send_message',
  description: 'Post a message to a chat room. Use this to communicate with other agents or report status in a feature coordination room.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: { type: 'string', description: 'Chat room ID to post the message to' },
      content: { type: 'string', description: 'Message content to post' },
    },
    required: ['room_id', 'content'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'rooms',
  handler: handleSendMessage,
}

export const orionSetGoalTool: ToolDefinition = {
  name: 'orion_set_goal',
  description: 'Set an active goal for a chat room. While a goal is active, agents in the room must respond with progress rather than going silent. Use this when you want an agent to keep working until a task is explicitly done.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: { type: 'string', description: 'Chat room ID to set the goal in' },
      goal:    { type: 'string', description: 'Clear description of what must be accomplished' },
    },
    required: ['room_id', 'goal'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'rooms',
  handler: handleSetGoal,
}

export const orionCompleteGoalTool: ToolDefinition = {
  name: 'orion_complete_goal',
  description: 'Mark the active goal in a chat room as complete and clear it. GUARD: Only call this after you have VERIFIED the goal is actually done — check pod status, test endpoints, confirm resources are healthy. Do NOT call this just because a PR was merged, a command was issued, or you believe the work should be done. You must have observed real evidence of success (e.g. kubectl_get_pods showing Running, HTTP 200 from the endpoint). Provide a verification_summary describing exactly what you checked.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id:              { type: 'string', description: 'Chat room ID to clear the goal from' },
      verification_summary: { type: 'string', description: 'What you actually checked to confirm the goal is complete. E.g. "kubectl_get_pods shows all 7 arr-stack pods Running; curl sonarr.khalisio.com returns 200". Required — vague answers will be rejected.' },
    },
    required: ['room_id', 'verification_summary'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'rooms',
  handler: handleCompleteGoal,
}
