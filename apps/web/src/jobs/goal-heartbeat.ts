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
  const activeGoals = await prisma.roomGoal.findMany({
    where: { status: 'active' },
    select: { roomId: true, text: true },
  })
  if (activeGoals.length === 0) return

  const now = Date.now()

  for (const goal of activeGoals) {
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
