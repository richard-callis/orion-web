import { prisma } from '@/lib/db'
import { triggerRoomAgentReplies } from '@/lib/room-agents'

// A goal room is "stale" if its most recent non-system message is older than this.
const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes

// The unanswered-message sweep only looks at messages within this window. Without
// an upper bound it would, on first deploy, wake every historically dormant room
// whose last message happens to be human, and re-nudge any room whose trigger
// never produces a reply (rate limit, LLM error) on every single tick forever.
// 24h bounds the worst case to "renudged every 5 min for at most a day", not
// indefinitely — a room that's been silently stuck longer than that needs a
// human to look at it, not another automated nudge.
const UNANSWERED_LOOKBACK_MS = 24 * 60 * 60 * 1000 // 24 hours
const UNANSWERED_SWEEP_LIMIT = 100 // cap rooms processed per tick, not just per query

// parseMentions (room-agents.ts) is `/@([\w-]+)/g` — ASCII word chars and hyphen
// only. An agent name outside that (spaces, dots, accents) would make the
// mention-routing branch in triggerRoomAgentReplies match zero agents and
// return early with NO fallback to broadcast — silently nudging nobody, which
// is worse than the noisy-broadcast behavior this file exists to fix. Only
// build an @-mention nudge when the name is guaranteed to round-trip through
// that regex.
const MENTION_SAFE_NAME = /^[\w-]+$/

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

      const primaryAgentName = await resolvePrimaryAgentName(goal.roomId)
      if (!primaryAgentName) continue // no agent members — nothing to nudge

      const body = `[Goal check-in] Still working on: "${goal.text}" — what is the current status and the next concrete step?`
      await triggerRoomAgentReplies(goal.roomId, buildNudge(primaryAgentName, body))
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
 * is from a human, within the last 24h, and has sat unanswered past the stale
 * threshold gets a generic nudge, independent of room_goal status. It is
 * intentionally additive — rooms already handled by the goal sweep this tick
 * are skipped so a room never gets nudged twice in one pass.
 */
async function runUnansweredMessageSweep(now: number, handledRoomIds: Set<string>): Promise<void> {
  // Latest non-system message per room, bounded to a lookback window so this
  // can't become a full-table scan or wake rooms that have been dormant for
  // months. `take` is applied after `distinct` (one row per room), so it caps
  // rooms actually processed this tick, not raw rows read.
  const lastMessagePerRoom = await prisma.chatMessage.findMany({
    where: { senderType: { not: 'system' }, createdAt: { gte: new Date(now - UNANSWERED_LOOKBACK_MS) } },
    distinct: ['roomId'],
    orderBy: [{ roomId: 'asc' }, { createdAt: 'desc' }],
    select: { roomId: true, senderType: true, createdAt: true },
    take: UNANSWERED_SWEEP_LIMIT,
  })

  for (const msg of lastMessagePerRoom) {
    if (msg.senderType !== 'human') continue
    if (handledRoomIds.has(msg.roomId)) continue
    if (now - msg.createdAt.getTime() < STALE_THRESHOLD_MS) continue

    try {
      const primaryAgentName = await resolvePrimaryAgentName(msg.roomId)
      if (!primaryAgentName) continue

      const body = 'There is an unanswered message in this room — review recent chat history and respond.'
      await triggerRoomAgentReplies(msg.roomId, buildNudge(primaryAgentName, `[Message check-in] ${body}`))
    } catch (e) {
      console.error(`[goal-heartbeat] unanswered-message sweep failed for room ${msg.roomId}:`, e)
    }
  }
}

/**
 * @-mention `agentName` if it's guaranteed to survive triggerRoomAgentReplies'
 * mention regex round-trip; otherwise fall back to an unmentioned nudge (noisy
 * broadcast to every non-watch-prompt agent, same as before this file's fix)
 * rather than risk the mention path silently matching zero agents.
 */
function buildNudge(agentName: string, body: string): string {
  return MENTION_SAFE_NAME.test(agentName) ? `@${agentName} ${body}` : body
}

/**
 * Picks exactly one agent to receive heartbeat nudges for a room, so re-triggers
 * never fan out to the whole room the way an unmentioned trigger does when no
 * ring leader or lead-role agent is configured (see triggerRoomAgentReplies'
 * fallback branch — it broadcasts to every non-watch-prompt agent in that case,
 * which is correct for a live open-ended human question but wrong for a
 * mechanical "are you still working on this" poke).
 *
 * Priority: room's configured ring leader → agent with role 'lead' → the
 * earliest-joined non-watch-prompt agent (stable across ticks, so the same
 * agent gets nudged every time rather than a different one each poll).
 */
async function resolvePrimaryAgentName(roomId: string): Promise<string | null> {
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    select: { metadata: true },
  })
  const ringLeaderId = (room?.metadata as Record<string, unknown> | null)?.ringLeaderAgentId as string | undefined

  const members = await prisma.chatRoomMember.findMany({
    where: { roomId, agentId: { not: null } },
    orderBy: { joinedAt: 'asc' },
    select: { role: true, agent: { select: { id: true, name: true, metadata: true } } },
  })
  const active = members.filter(m => m.agent && (m.agent.metadata as Record<string, unknown> | null)?.archived !== true)
  if (active.length === 0) return null

  if (ringLeaderId) {
    const leader = active.find(m => m.agent!.id === ringLeaderId)
    if (leader) return leader.agent!.name
  }

  const lead = active.find(m => m.role === 'lead')
  if (lead) return lead.agent!.name

  const nonWatchers = active.filter(m => {
    const cc = ((m.agent!.metadata as Record<string, unknown> | null)?.contextConfig ?? {}) as Record<string, unknown>
    return !cc.watchPrompt
  })
  return (nonWatchers[0] ?? active[0]).agent!.name
}
