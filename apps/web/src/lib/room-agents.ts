/**
 * Room agent response engine.
 *
 * After a human sends a message to a chat room, this module:
 * 1. Determines which agents should reply (all agents, or only @mentioned ones)
 * 2. Builds a system prompt + conversation history for each agent
 * 3. Calls the appropriate LLM based on the agent's contextConfig.llm
 * 4. Saves each reply as a ChatMessage in the room
 *
 * Supported LLM routes (same as streamAgentChat):
 *   claude / claude:<model>   — Claude Code SDK (OAuth credentials)
 *   ollama:<model>            — Ollama /api/chat
 *   ext:<id>                  — ExternalModel lookup → Ollama or OpenAI-compatible
 *   gemini:<model>            — falls back to Claude for now
 */

import fs from 'fs'
import path from 'path'
import { prisma } from './db'

// ── Mention parsing ───────────────────────────────────────────────────────────

/** Extract @Name tokens from a message. */
export function parseMentions(content: string): string[] {
  return (content.match(/@([\w-]+)/g) ?? []).map(m => m.slice(1))
}

// ── Credential helpers (mirrors claude.ts) ────────────────────────────────────

function setupClaudeCredentials(): void {
  if (!process.env.CLAUDE_CREDENTIALS_PATH) return
  try {
    const src  = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
    const dest = '/tmp/claude-home/.claude/.credentials.json'
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(src)) fs.copyFileSync(src, dest)
  } catch { /* best-effort */ }
}

// ── LLM call helpers ──────────────────────────────────────────────────────────

function buildMessages(systemPrompt: string, historyText: string, latestMessage: string) {
  const sys = historyText
    ? `${systemPrompt}\n\n---\nRecent room conversation:\n${historyText}\n---`
    : systemPrompt
  return { sys, user: latestMessage }
}

/** Claude Code SDK — OAuth credentials, same path as streamClaudeResponse */
async function callClaude(
  systemPrompt: string,
  historyText: string,
  latestMessage: string,
  modelId?: string,
): Promise<string | null> {
  setupClaudeCredentials()
  const { query } = await import('@anthropic-ai/claude-code')
  const { sys, user } = buildMessages(systemPrompt, historyText, latestMessage)
  const response = query({
    prompt: user,
    options: {
      allowedTools: [],
      maxTurns: 1,
      customSystemPrompt: sys,
      ...(modelId ? { model: modelId } : {}),
    },
  })
  let text = ''
  for await (const raw of response) {
    const msg = raw as { type: string; message?: { content: Array<{ type: string; text?: string }> }; subtype?: string; result?: string }
    if (msg.type === 'assistant' && msg.message) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) text += block.text
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
      if (!text.includes(msg.result.trim())) text += msg.result
    }
  }
  return text.trim() || null
}

/** Ollama native /api/chat endpoint */
async function callOllamaChat(
  systemPrompt: string,
  historyText: string,
  latestMessage: string,
  model: string,
  baseUrl: string,
): Promise<string | null> {
  const { sys, user } = buildMessages(systemPrompt, historyText, latestMessage)
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    console.error(`[room-agents] Ollama ${baseUrl} returned HTTP ${res.status}`)
    return null
  }
  const data = await res.json() as { message?: { content?: string } }
  return data.message?.content?.trim() || null
}

/** OpenAI-compatible /v1/chat/completions endpoint */
async function callOpenAIChat(
  systemPrompt: string,
  historyText: string,
  latestMessage: string,
  model: string,
  baseUrl: string,
  apiKey?: string | null,
): Promise<string | null> {
  const { sys, user } = buildMessages(systemPrompt, historyText, latestMessage)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    console.error(`[room-agents] OpenAI-compat ${baseUrl} returned HTTP ${res.status}`)
    return null
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content?.trim() || null
}

/** Resolve a fallback Ollama base URL from configured ExternalModels */
async function resolveOllamaBaseUrl(): Promise<string> {
  const m = await prisma.externalModel.findFirst({
    where: { provider: 'ollama', enabled: true },
    select: { baseUrl: true },
  })
  return m?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Trigger agent replies for a chat room message (fire-and-forget from POST handler).
 *
 * Routing:
 * - @mention present → only mentioned agents reply
 * - No @mention      → all agent members reply
 */
export async function triggerRoomAgentReplies(
  roomId: string,
  triggerContent: string,
): Promise<void> {
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

  const mentionedNames  = parseMentions(triggerContent)
  const triggeredAgents = mentionedNames.length > 0
    ? agentMembers.filter(a => mentionedNames.some(n => a.name.toLowerCase() === n.toLowerCase()))
    : agentMembers

  if (triggeredAgents.length === 0) return

  for (const agent of triggeredAgents) {
    try {
      // Re-fetch history each iteration so each agent sees the previous agent's reply
      const recentMessages = await prisma.chatMessage.findMany({
        where: { roomId },
        orderBy: { createdAt: 'desc' },
        take: 21,
        include: {
          agent: { select: { name: true } },
          user:  { select: { username: true, name: true } },
        },
      })
      recentMessages.reverse()

      // The last message is the trigger — everything before it is history
      const historyText = recentMessages
        .slice(0, -1)
        .filter(m => m.senderType !== 'system')
        .map(m => {
          const name = m.agent?.name ?? m.user?.name ?? m.user?.username ?? 'User'
          return `${name}: ${m.content}`
        })
        .join('\n')

      const meta          = (agent.metadata ?? {}) as Record<string, unknown>
      const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
      const rawPrompt     = meta.systemPrompt as string | undefined
      const llm           = (contextConfig.llm as string | undefined) ?? 'claude:claude-haiku-4-5-20251001'

      const systemPrompt = rawPrompt
        ? `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}.\n\n${rawPrompt}`
        : `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}${agent.description ? `.\n\n${agent.description}` : '.'}`

      console.log(`[room-agents] ${agent.name} (${llm}) → replying to room ${roomId}`)

      let reply: string | null = null

      if (llm.startsWith('ext:')) {
        const extId  = llm.slice('ext:'.length)
        const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
        if (!extModel) {
          console.error(`[room-agents] ext model ${extId} not found`)
          continue
        }
        const baseUrl = extModel.baseUrl ?? 'http://localhost:11434'
        if (extModel.provider === 'ollama') {
          reply = await callOllamaChat(systemPrompt, historyText, triggerContent, extModel.modelId, baseUrl)
        } else {
          // openai / custom — OpenAI-compatible
          reply = await callOpenAIChat(systemPrompt, historyText, triggerContent, extModel.modelId, baseUrl, extModel.apiKey)
        }
      } else if (llm.startsWith('ollama:')) {
        const model   = llm.slice('ollama:'.length)
        const baseUrl = await resolveOllamaBaseUrl()
        reply = await callOllamaChat(systemPrompt, historyText, triggerContent, model, baseUrl)
      } else {
        // claude / claude:<model>
        const claudeModel = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
        reply = await callClaude(systemPrompt, historyText, triggerContent, claudeModel)
      }

      if (!reply) {
        console.warn(`[room-agents] ${agent.name} returned empty reply`)
        continue
      }

      await prisma.chatMessage.create({
        data: { roomId, agentId: agent.id, senderType: 'agent', content: reply },
      })
      await prisma.chatRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } })
      console.log(`[room-agents] ${agent.name} replied (${reply.length} chars)`)
    } catch (e) {
      console.error(`[room-agents] ${agent.name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
