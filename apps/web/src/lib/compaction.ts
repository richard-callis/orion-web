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

type OpenAICompatMessage = { role: string; content: string }

/**
 * Call a model via OpenAI-compatible /v1/chat/completions for compaction.
 * Returns the model's text reply or null on failure.
 */
async function callForSummary(
  baseUrl: string,
  modelId: string,
  apiKey: string | null | undefined,
  transcript: string,
): Promise<string | null> {
  const messages: OpenAICompatMessage[] = [
    { role: 'user', content: COMPACTION_PROMPT + transcript },
  ]
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: modelId, stream: false, messages }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      console.error(`[compaction] model ${modelId} at ${baseUrl} returned HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { choices?: Array<{ message: { content: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch (err) {
    console.error(`[compaction] callForSummary failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

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

  // Resolve the default model setting
  const defaultModelSetting = await prisma.systemSetting.findUnique({ where: { key: 'ai.default-model' } })
  const rawDefault = defaultModelSetting?.value
  const defaultModelId: string = typeof rawDefault === 'string'
    ? rawDefault.replace(/^"|"$/g, '')
    : (typeof rawDefault === 'object' && rawDefault !== null ? String(rawDefault) : '')

  let summary: string | null = null

  // Resolve which model to use
  if (defaultModelId.startsWith('ext:')) {
    const extId = defaultModelId.slice('ext:'.length)
    const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
    if (extModel) {
      summary = await callForSummary(extModel.baseUrl, extModel.modelId, extModel.apiKey, transcript)
    }
  } else if (defaultModelId.startsWith('ollama:')) {
    // Find first enabled Ollama model
    const ollamaModel = await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
    if (ollamaModel) {
      summary = await callForSummary(ollamaModel.baseUrl, ollamaModel.modelId, null, transcript)
    }
  }

  // Fallback: use any enabled external model with OpenAI compat
  if (!summary) {
    const fallback = await prisma.externalModel.findFirst({
      where: { enabled: true, provider: { not: 'ollama' } },
    })
    if (fallback) {
      summary = await callForSummary(fallback.baseUrl, fallback.modelId, fallback.apiKey, transcript)
    }
  }

  // Last resort: try any enabled model
  if (!summary) {
    const last = await prisma.externalModel.findFirst({ where: { enabled: true } })
    if (last) {
      summary = await callForSummary(last.baseUrl, last.modelId, last.apiKey, transcript)
    }
  }

  if (!summary) {
    throw new Error('[compaction] failed to generate summary — no usable model found')
  }

  // Persist as a compaction message and reset the room's token counter
  const compactionMsg = await prisma.chatMessage.create({
    data: {
      roomId,
      senderType: 'compaction',
      content: summary,
      attachments: { originalMessageCount: messages.length, compactedAt: new Date().toISOString() } as unknown as object,
    },
  })

  await prisma.chatRoom.update({
    where: { id: roomId },
    data: { tokenCount: 0, updatedAt: new Date() },
  })

  // Publish via Redis so the UI shows the compaction message live
  await publishChatMessage(roomId, {
    id:          compactionMsg.id,
    senderType:  'compaction',
    content:     summary,
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
