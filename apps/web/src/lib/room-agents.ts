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

type HistoryEntry = { name: string; content: string; isSelf: boolean }
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Build the system prompt with a hard identity constraint at the very top.
 * The constraint must come FIRST so the model cannot ignore it.
 */
function buildSystemPrompt(agentName: string, agentBasePrompt: string): string {
  return `IMPORTANT — YOUR ROLE:
You are ${agentName}. You are ONE participant in a group chat.
Rules you must follow without exception:
1. Write ONE short reply as yourself only.
2. Do NOT write responses, speech, or dialogue for any other participant.
3. Do NOT use speaker labels like "${agentName}:" or any name prefix in your reply.
4. Do NOT write scripts, screenplays, or simulated multi-turn exchanges.
5. Do NOT invent what other participants might say next.
6. If the conversation has naturally concluded or you have nothing meaningful to add, reply with exactly the single word: SILENT

---
${agentBasePrompt}`
}

/**
 * Convert structured history + latest message into a proper messages array.
 * Prior messages FROM this agent → role: "assistant"
 * All other messages → role: "user" (with speaker name prefix so the model knows who said it)
 */
function buildChatMessages(history: HistoryEntry[], latestMessage: string): ChatMsg[] {
  const messages: ChatMsg[] = []
  for (const entry of history) {
    if (entry.isSelf) {
      messages.push({ role: 'assistant', content: entry.content })
    } else {
      messages.push({ role: 'user', content: `${entry.name}: ${entry.content}` })
    }
  }
  messages.push({ role: 'user', content: latestMessage })
  return messages
}

/** Claude Code SDK — OAuth credentials, same path as streamClaudeResponse */
async function callClaude(
  agentName: string,
  agentBasePrompt: string,
  history: HistoryEntry[],
  latestMessage: string,
  modelId?: string,
): Promise<string | null> {
  setupClaudeCredentials()
  const { query } = await import('@anthropic-ai/claude-code')
  const sys = buildSystemPrompt(agentName, agentBasePrompt)
  // Claude query() only accepts a single prompt string — prepend history as context
  const historyBlock = history.length
    ? history.map(e => `${e.name}: ${e.content}`).join('\n') + '\n\n'
    : ''
  const prompt = historyBlock + latestMessage
  const response = query({
    prompt,
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
  agentName: string,
  agentBasePrompt: string,
  history: HistoryEntry[],
  latestMessage: string,
  model: string,
  baseUrl: string,
): Promise<string | null> {
  const sys = buildSystemPrompt(agentName, agentBasePrompt)
  const chatMsgs = buildChatMessages(history, latestMessage)
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: sys }, ...chatMsgs],
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
  agentName: string,
  agentBasePrompt: string,
  history: HistoryEntry[],
  latestMessage: string,
  model: string,
  baseUrl: string,
  apiKey?: string | null,
): Promise<string | null> {
  const sys = buildSystemPrompt(agentName, agentBasePrompt)
  const chatMsgs = buildChatMessages(history, latestMessage)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: sys }, ...chatMsgs],
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
 * Max rounds of agent-to-agent chaining after the initial human trigger.
 * depth=0 → human triggered, depth=1..MAX → agent reply triggered by prior agent reply.
 */
const MAX_AGENT_CHAIN_DEPTH = 3

/**
 * Trigger agent replies for a chat room message (fire-and-forget from POST handler).
 *
 * Routing:
 * - @mention present → only mentioned agents reply
 * - No @mention      → all agent members reply
 *
 * After each round, if any saved reply @mentions another agent the chain recurses
 * (up to MAX_AGENT_CHAIN_DEPTH) so agents can respond to each other naturally.
 */
export async function triggerRoomAgentReplies(
  roomId: string,
  triggerContent: string,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_AGENT_CHAIN_DEPTH) return
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

  let lastSavedReply: string | null = null

  for (const agent of triggeredAgents) {
    try {
      // Re-fetch history each iteration so each agent sees the previous agent's reply
      const recentMessages = await prisma.chatMessage.findMany({
        where: { roomId },
        orderBy: { createdAt: 'desc' },
        take: 21,
        include: {
          agent: { select: { id: true, name: true } },
          user:  { select: { username: true, name: true } },
        },
      })
      recentMessages.reverse()

      // All messages except the very last are history context.
      // The very last message is what this agent is directly responding to.
      const historyMsgs = recentMessages.slice(0, -1).filter(m => m.senderType !== 'system')
      const lastMsg     = recentMessages[recentMessages.length - 1]
      const lastSender  = lastMsg?.agent?.name ?? lastMsg?.user?.name ?? lastMsg?.user?.username ?? 'User'
      const latestTurn  = lastMsg ? `${lastSender}: ${lastMsg.content}` : triggerContent

      // Build structured history with isSelf flag so LLMs can use proper role assignments
      const history: HistoryEntry[] = historyMsgs.map(m => ({
        name:   m.agent?.name ?? m.user?.name ?? m.user?.username ?? 'User',
        content: m.content,
        isSelf: m.agentId === agent.id,
      }))

      const meta          = (agent.metadata ?? {}) as Record<string, unknown>
      const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
      const rawPrompt     = meta.systemPrompt as string | undefined
      const llm           = (contextConfig.llm as string | undefined) ?? 'claude:claude-haiku-4-5-20251001'

      // Base persona description — identity constraint is added by buildSystemPrompt()
      const agentBasePrompt = rawPrompt
        ? `${agent.role ? `Role: ${agent.role}\n\n` : ''}${rawPrompt}`
        : `${agent.role ? `Role: ${agent.role}\n\n` : ''}${agent.description ?? ''}`

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
          reply = await callOllamaChat(agent.name, agentBasePrompt, history, latestTurn, extModel.modelId, baseUrl)
        } else {
          // openai / custom — OpenAI-compatible
          reply = await callOpenAIChat(agent.name, agentBasePrompt, history, latestTurn, extModel.modelId, baseUrl, extModel.apiKey)
        }
      } else if (llm.startsWith('ollama:')) {
        const model   = llm.slice('ollama:'.length)
        const baseUrl = await resolveOllamaBaseUrl()
        reply = await callOllamaChat(agent.name, agentBasePrompt, history, latestTurn, model, baseUrl)
      } else {
        // claude / claude:<model>
        const claudeModel = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
        reply = await callClaude(agent.name, agentBasePrompt, history, latestTurn, claudeModel)
      }

      if (!reply) {
        console.warn(`[room-agents] ${agent.name} returned empty reply`)
        continue
      }
      if (reply.trim().toUpperCase() === 'SILENT') {
        console.log(`[room-agents] ${agent.name} chose not to respond`)
        continue
      }

      await prisma.chatMessage.create({
        data: { roomId, agentId: agent.id, senderType: 'agent', content: reply },
      })
      await prisma.chatRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } })
      console.log(`[room-agents] ${agent.name} replied (${reply.length} chars)`)
      lastSavedReply = reply
    } catch (e) {
      console.error(`[room-agents] ${agent.name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Chain: if the last reply @mentions another agent, trigger the next round
  if (lastSavedReply && parseMentions(lastSavedReply).length > 0) {
    console.log(`[room-agents] depth=${depth} — chaining reply with @mentions`)
    await triggerRoomAgentReplies(roomId, lastSavedReply, depth + 1)
  }
}
