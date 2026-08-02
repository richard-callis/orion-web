import { prisma } from '@/lib/db'
import { triggerRoomAgentReplies } from '@/lib/room-agents'

// A goal room is "stale" if its most recent non-system message is older than this.
const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Periodic sweep: find rooms with an active goal that have gone quiet and
 * re-trigger their agents. triggerRoomAgentReplies already self-fetches the
 * active goal and injects it into agent prompts — we only pass a nudge as
 * the trigger content. We do NOT persist a chat message; doing so would reset
 * the staleness clock and prevent the heartbeat from ever firing again.
 */
export async function runGoalHeartbeat(): Promise<void> {
  const now = Date.now()
  const handledRoomIds = new Set<string>()

  await runActiveGoalSweep(now, handledRoomIds)
  await runUnansweredMessageSweep(now, handledRoomIds)
}

async function runActiveGoalSweep(now: number, handledRoomIds: Set<string>): Promise<void> {
  const activeGoals = await prisma.roomGoal.findMany({
    where: { status: 'active' },
    select: { roomId: true, text: true },
  })

  for (const goal of activeGoals) {
    handledRoomIds.add(goal.roomId)
    try {
      // Exclude system messages from the staleness check — a prior heartbeat
      // nudge must not mask real inactivity.
      const lastMsg = await prisma.chatMessage.findFirst({
        where: { roomId: goal.roomId, senderType: { not: 'system' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      const lastActivity = lastMsg ? lastMsg.createdAt.getTime() : 0
      if (now - lastActivity < STALE_THRESHOLD_MS) continue

      // Optimization only (not correctness): skip rooms with no agent members.
      // triggerRoomAgentReplies returns early for empty rooms anyway.
      const agentMember = await prisma.chatRoomMember.findFirst({
        where: { roomId: goal.roomId, agentId: { not: null } },
        select: { id: true },
      })
      if (!agentMember) continue

      const nudge = `[Goal check-in] Still working on: "${goal.text}" — what is the current status and the next concrete step?`
      await triggerRoomAgentReplies(goal.roomId, nudge)
    } catch (e) {
      // Isolate per-room failures so one bad room never aborts the whole sweep.
      console.error(`[goal-heartbeat] room ${goal.roomId} failed:`, e)
    }
  }
}

/**
 * Goal-independent safety net. The active-goal sweep above is the primary
 * mechanism, but a room's goal can be marked complete/abandoned (by an agent,
 * by whatever process decided the work was done, or by mistake) while a human
 * is still mid-conversation in it. Live messages sent through the chat API
 * already trigger agent replies immediately regardless of goal state — but
 * that only fires once, at send time. If routing (mentions/ring-leader/lead
 * fallback) produces no responder, or the trigger silently fails, there is
 * currently nothing that revisits the room once its goal is gone.
 *
 * This sweep catches that case: any room whose most recent non-system message
 * is from a human and has sat unanswered past the stale threshold gets a
 * generic nudge, independent of room_goal status. It is intentionally
 * additive — rooms already handled by the goal sweep this tick are skipped
 * so a room never gets nudged twice in one pass.
 */
async function runUnansweredMessageSweep(now: number, handledRoomIds: Set<string>): Promise<void> {
  // Latest non-system message per room, in one query rather than N+1 lookups.
  const lastMessagePerRoom = await prisma.chatMessage.findMany({
    where: { senderType: { not: 'system' } },
    distinct: ['roomId'],
    orderBy: [{ roomId: 'asc' }, { createdAt: 'desc' }],
    select: { roomId: true, senderType: true, createdAt: true },
  })

  for (const msg of lastMessagePerRoom) {
    if (msg.senderType !== 'human') continue
    if (handledRoomIds.has(msg.roomId)) continue
    if (now - msg.createdAt.getTime() < STALE_THRESHOLD_MS) continue

    try {
      const agentMember = await prisma.chatRoomMember.findFirst({
        where: { roomId: msg.roomId, agentId: { not: null } },
        select: { id: true },
      })
      if (!agentMember) continue

      const nudge = '[Message check-in] There is an unanswered message in this room — review recent chat history and respond.'
      await triggerRoomAgentReplies(msg.roomId, nudge)
    } catch (e) {
      console.error(`[goal-heartbeat] unanswered-message sweep failed for room ${msg.roomId}:`, e)
    }
  }
}
