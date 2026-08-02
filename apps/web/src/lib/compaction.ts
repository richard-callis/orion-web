/**
 * Context compaction for chat rooms.
 *
 * When a room's context utilisation reaches 90% of the model's context limit
 * the system auto-compacts; at 70% it emits a warning banner via SSE.
 *
 * Compaction works by:
 * 1. Fetching all messages since the last compaction (or all messages if none).
 * 2. Asking the default AI model to summarise them into a structured markdown block.
 * 3. Saving the summary as a `senderType: 'compaction'` ChatMessage.
 * 4. Resetting the room's tokenCount to 0.
 * 5. Publishing the new compaction message via Redis SSE so it appears live.
 *
 * Future history queries use the compaction message as their start boundary,
 * so the LLM always receives an accurate, space-efficient conversation context.
 */

import { prisma } from './db'
import { publishChatMessage, publishToRoom } from './chat-redis'
import { callDefaultModel } from './default-model'

// ── Concurrency guard ─────────────────────────────────────────────────────────
// Prevents two simultaneous compactions for the same room (e.g. two agents both
// hitting the 90% threshold in the same turn). A simple in-process Set is sufficient
// since compaction is triggered from within a single Next.js server process.
const compactingRooms = new Set<string>()

const COMPACTION_PROMPT = `You are summarizing a conversation for context compaction. Your goal is to create a comprehensive but concise summary that preserves:

- All key decisions made and their rationale
- Current task status and what has been accomplished
- Open questions, blockers, and next steps
- Important facts, numbers, file paths, or technical details
- The overall goal and where things currently stand

Format the summary in markdown with clear sections. Be complete — this summary will replace the full conversation history for the AI agents involved.

Conversation transcript to summarize:
`

/**
 * Compact the conversation history for a room into a single summary message.
 * Throws if the summary cannot be generated.
 */
export async function compactRoom(roomId: string): Promise<void> {
  // Guard: skip if this room is already being compacted
  if (compactingRooms.has(roomId)) {
    console.warn(`[compaction] room ${roomId}: compaction already in progress — skipping`)
    return
  }
  compactingRooms.add(roomId)

  try {
    await _compactRoom(roomId)
  } finally {
    compactingRooms.delete(roomId)
  }
}

async function _compactRoom(roomId: string): Promise<void> {
  // Find the most recent compaction boundary — only compact messages since then
  const lastCompaction = await prisma.chatMessage.findFirst({
    where: { roomId, senderType: 'compaction' },
    orderBy: { createdAt: 'desc' },
  })

  const messages = await prisma.chatMessage.findMany({
    where: {
      roomId,
      senderType: { notIn: ['system', 'compaction'] },
      ...(lastCompaction ? { createdAt: { gt: lastCompaction.createdAt } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { name: true } },
      user:  { select: { username: true, name: true } },
    },
  })

  if (messages.length === 0) {
    console.warn(`[compaction] room ${roomId}: nothing to compact`)
    return
  }

  // Build a transcript the LLM can summarise
  const lines: string[] = []
  if (lastCompaction) {
    lines.push('## Prior Context (already summarised)')
    lines.push(lastCompaction.content)
    lines.push('')
    lines.push('## Continuation')
  }
  for (const m of messages) {
    if (m.senderType === 'tool_call') {
      const att = m.attachments as { tool?: string; output?: string } | null
      lines.push(`[tool: ${att?.tool ?? m.content}] → ${(att?.output ?? '').slice(0, 300)}`)
    } else {
      const name = m.agent?.name ?? m.user?.name ?? m.user?.username ?? 'User'
      lines.push(`${name}: ${m.content}`)
    }
  }
  const transcript = lines.join('\n')

  // Ask whatever model is configured as the system default (Settings → AI) to
  // summarise — delegates to the shared resolver instead of reimplementing
  // model routing here. The previous version only understood 'ext:'- and
  // 'ollama:'-prefixed model ids and had no branch at all for the literal
  // value 'claude' (Claude Code SDK) — on any install actually defaulting to
  // Claude, which is the common case, compaction always fell through to
  // querying for an unrelated external model instead of using the configured
  // default, and produced no summary at all if none happened to be enabled.
  let summary: string | null = null
  try {
    summary = await callDefaultModel(COMPACTION_PROMPT + transcript)
  } catch (err) {
    console.error(`[compaction] callDefaultModel failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!summary) {
    throw new Error('[compaction] failed to generate summary — no usable model found')
  }

  // Cap summary length to prevent unbounded growth.
  const MAX_SUMMARY_CHARS = 8000
  const cappedSummary = summary.length > MAX_SUMMARY_CHARS
    ? summary.slice(0, MAX_SUMMARY_CHARS) + '\n\n[Summary truncated — exceeded max length]'
    : summary

  // Transactional idempotency re-check: verify no other process compacted this
  // window while our LLM call was in flight. Also wraps create+reset atomically.
  const compactionMsg = await prisma.$transaction(async (tx) => {
    const currentBoundary = await tx.chatMessage.findFirst({
      where: { roomId, senderType: 'compaction' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (currentBoundary?.id !== lastCompaction?.id) {
      console.warn(`[compaction] room ${roomId}: another worker compacted concurrently — skipping duplicate`)
      return null
    }
    const msg = await tx.chatMessage.create({
      data: {
        roomId,
        senderType: 'compaction',
        content: cappedSummary,
        attachments: { originalMessageCount: messages.length, compactedAt: new Date().toISOString() } as unknown as object,
      },
    })
    await tx.chatRoom.update({
      where: { id: roomId },
      data: { tokenCount: 0, updatedAt: new Date() },
    })
    return msg
  })

  if (!compactionMsg) return  // concurrent compaction won the race

  // Publish via Redis so the UI shows the compaction message live
  await publishChatMessage(roomId, {
    id:          compactionMsg.id,
    senderType:  'compaction',
    content:     cappedSummary,
    attachments: { originalMessageCount: messages.length, compactedAt: compactionMsg.createdAt instanceof Date ? compactionMsg.createdAt.toISOString() : compactionMsg.createdAt },
    sender:      { type: 'system', id: null, name: 'System' },
    createdAt:   compactionMsg.createdAt instanceof Date ? compactionMsg.createdAt.toISOString() : compactionMsg.createdAt,
  })

  console.log(`[compaction] room ${roomId}: compacted ${messages.length} messages into summary`)
}

/**
 * Publish a compaction threshold warning as a system message in the room.
 * Saves to DB so it persists after page refresh.
 */
export async function publishCompactionWarning(
  roomId: string,
  percentage: number,
  tokenCount: number,
  tokenLimit: number,
): Promise<void> {
  const pct = Math.round(percentage * 100)
  const content = `Context is at ${pct}% capacity (${tokenCount.toLocaleString()} / ${tokenLimit.toLocaleString()} tokens). Consider compacting the conversation to free up context.`

  const msg = await prisma.chatMessage.create({
    data: {
      roomId,
      senderType: 'system',
      content,
      attachments: {
        type:       'compaction-warning',
        percentage: pct,
        tokenCount,
        tokenLimit,
      } as unknown as object,
    },
  })

  await publishChatMessage(roomId, {
    id:          msg.id,
    senderType:  'system',
    content,
    attachments: { type: 'compaction-warning', percentage: pct, tokenCount, tokenLimit },
    sender:      { type: 'system', id: null, name: 'System' },
    createdAt:   msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
  })
}

/**
 * Publish an ephemeral token update via SSE.
 * Does NOT write to the database — pure real-time signal for the UI.
 */
export async function publishTokenUpdate(
  roomId: string,
  tokenCount: number,
  tokenLimit: number,
): Promise<void> {
  const percentage = tokenLimit > 0 ? Math.round((tokenCount / tokenLimit) * 100) : 0
  await publishToRoom(roomId, {
    type: 'token-update',
    tokenCount,
    tokenLimit,
    percentage,
  })
}
