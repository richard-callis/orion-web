/**
 * Room agent response engine.
 *
 * After a human sends a message to a chat room, this module:
 * 1. Determines which agents should reply (all agents, or only @mentioned ones)
 * 2. Builds a system prompt + conversation history for each agent
 * 3. Calls the appropriate LLM (Claude / Ollama) based on the agent's contextConfig
 * 4. Saves each reply as a ChatMessage in the room
 */

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from './db'

// ── Mention parsing ───────────────────────────────────────────────────────────

/**
 * Extract @mention names from a message string.
 * e.g. "Hey @Alpha can you check this?" → ["Alpha"]
 */
export function parseMentions(content: string): string[] {
  const matches = content.match(/@([\w-]+)/g) ?? []
  return matches.map(m => m.slice(1))
}

// ── LLM calls ────────────────────────────────────────────────────────────────

async function callClaude(
  systemPrompt: string,
  historyText: string,
  latestMessage: string,
  modelId?: string,
): Promise<string | null> {
  const client = new Anthropic()
  const model = modelId ?? 'claude-haiku-4-5-20251001'

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: historyText
      ? `${systemPrompt}\n\n---\nRecent room conversation:\n${historyText}\n---`
      : systemPrompt,
    messages: [{ role: 'user', content: latestMessage }],
  })

  const block = response.content.find(b => b.type === 'text')
  return block?.type === 'text' ? block.text : null
}

async function callOllama(
  systemPrompt: string,
  historyText: string,
  latestMessage: string,
  model: string,
  baseUrl?: string,
): Promise<string | null> {
  const url = `${baseUrl ?? 'http://localhost:11434'}/api/chat`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: historyText
            ? `${systemPrompt}\n\n---\nRecent room conversation:\n${historyText}\n---`
            : systemPrompt,
        },
        { role: 'user', content: latestMessage },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return null
  const data = await res.json() as { message?: { content?: string } }
  return data.message?.content ?? null
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fire agent replies for a chat room message. Call without awaiting from the
 * POST handler so it doesn't block the HTTP response.
 *
 * Behaviour:
 * - If the message @mentions any agent in the room → only those agents reply
 * - If the message has no agent @mentions → all agent members reply
 */
export async function triggerRoomAgentReplies(
  roomId: string,
  triggerContent: string,
): Promise<void> {
  // Resolve which agents are in the room
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        where: { agentId: { not: null } },
        include: { agent: true },
      },
    },
  })

  const agentMembers = (room?.members ?? []).map(m => m.agent!).filter(Boolean)
  if (agentMembers.length === 0) return

  // Determine which agents to trigger
  const mentionedNames = parseMentions(triggerContent)
  const triggeredAgents = mentionedNames.length > 0
    ? agentMembers.filter(a => mentionedNames.some(n => a.name.toLowerCase() === n.toLowerCase()))
    : agentMembers

  if (triggeredAgents.length === 0) return

  // Build conversation history from recent room messages (excluding the trigger)
  const recentMessages = await prisma.chatMessage.findMany({
    where: { roomId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      agent: { select: { name: true } },
      user:  { select: { username: true, name: true } },
    },
  })
  recentMessages.reverse()

  // Format as a readable transcript (exclude the very last message = the trigger)
  const historyMessages = recentMessages.slice(0, -1)
  const historyText = historyMessages
    .filter(m => m.senderType !== 'system')
    .map(m => {
      const name = m.agent?.name ?? m.user?.name ?? m.user?.username ?? 'User'
      return `${name}: ${m.content}`
    })
    .join('\n')

  // Trigger each agent sequentially to avoid rate-limit spikes
  for (const agent of triggeredAgents) {
    try {
      const meta          = (agent.metadata ?? {}) as Record<string, unknown>
      const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
      const rawPrompt     = meta.systemPrompt as string | undefined
      const llm           = (contextConfig.llm as string | undefined) ?? 'claude'

      const systemPrompt = rawPrompt
        ? `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}.\n\n${rawPrompt}`
        : `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}${agent.description ? `.\n\n${agent.description}` : '.'}`

      let reply: string | null = null

      if (llm.startsWith('ollama:') || llm.startsWith('ext:')) {
        let model  = llm.startsWith('ollama:') ? llm.slice('ollama:'.length) : ''
        let baseUrl: string | undefined

        if (llm.startsWith('ext:')) {
          const extModel = await prisma.externalModel.findUnique({ where: { id: llm.slice('ext:'.length) } })
          if (!extModel) continue
          model   = extModel.modelId
          baseUrl = extModel.baseUrl ?? undefined
        }

        reply = await callOllama(systemPrompt, historyText, triggerContent, model, baseUrl)
      } else {
        // claude / claude:<model> / gemini (fallback to Claude for now)
        const claudeModel = llm.startsWith('claude:') ? llm.slice('claude:'.length) : 'claude-haiku-4-5-20251001'
        reply = await callClaude(systemPrompt, historyText, triggerContent, claudeModel)
      }

      if (!reply?.trim()) continue

      await prisma.chatMessage.create({
        data: { roomId, agentId: agent.id, senderType: 'agent', content: reply.trim() },
      })
      await prisma.chatRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[room-agents] ${agent.name} reply failed: ${msg}`)
    }
  }
}
