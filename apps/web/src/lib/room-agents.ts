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
 *   ollama:<model>            — Ollama /v1/chat/completions (OpenAI-compat, supports tool_calls)
 *   ext:<id>                  — ExternalModel lookup → Ollama or OpenAI-compatible
 *   gemini:<model>            — not yet supported; posts a clear error to the room
 */

import { prisma } from './db'
import { setTyping, clearTyping } from './typing-state'
import { buildToolDefinitions, TOOLS_SYSTEM_ADDENDUM, executeTool } from './agent-tools'
import { getToolsForContext, executeRegisteredTool } from './tool-registry'
import { publishChatMessage } from './chat-redis'
import { resolveAgentGateway } from './agent-gateway'
import { buildAgentContext, buildAgentLocalContext, buildRoomLocalContext, invalidateSnapshotCache, getModelContextLimit } from './agent-context'
import { compactRoom, publishCompactionWarning, publishTokenUpdate } from './compaction'
import { getPrompt } from './system-prompts'
import type { AgentGateway } from './agent-gateway'
import type { GatewayTool } from './agent-runner/types'

// ── Tool name fuzzy resolution ────────────────────────────────────────────────

/**
 * Attempt to resolve a hallucinated tool name to the closest real tool.
 * Uses word-overlap scoring: split both names on underscores and count matching
 * words (minimum 3 chars). High confidence = 2+ matching words; low = 1.
 *
 * Examples:
 *   "list_secrets"       → "orion_list_secrets"   (high: "list", "secrets")
 *   "gitops_list_files"  → "gitops_ls"             (low:  "gitops")
 *   "deploy_app"         → null                    (no clear winner)
 */
function resolveToolName(
  hallucinated: string,
  validNames: string[],
): { name: string; confidence: 'high' | 'low' } | null {
  if (validNames.length === 0) return null
  const hayWords = hallucinated.toLowerCase().split(/[_\-\s]+/).filter(w => w.length >= 3)
  if (hayWords.length === 0) return null

  const scored = validNames.map(name => {
    const needleWords = name.toLowerCase().split(/[_\-\s]+/).filter(w => w.length >= 3)
    const overlap = hayWords.filter(hw =>
      needleWords.some(nw => nw === hw || nw.includes(hw) || hw.includes(nw)),
    ).length
    return { name, overlap }
  }).sort((a, b) => b.overlap - a.overlap)

  const best = scored[0]
  if (best.overlap === 0) return null
  // Require the top score to be unambiguous (no tie at same overlap with a different name)
  const tied = scored.filter(s => s.overlap === best.overlap)
  if (tied.length > 1) {
    // Multiple equally-plausible matches — not safe to auto-correct
    return { name: best.name, confidence: 'low' }
  }
  return { name: best.name, confidence: best.overlap >= 2 ? 'high' : 'low' }
}

// ── Mention parsing ───────────────────────────────────────────────────────────

/** Extract @Name tokens from a message. */
export function parseMentions(content: string): string[] {
  return (content.match(/@([\w-]+)/g) ?? []).map((m: any) => m.slice(1))
}

// ── Credential helpers (mirrors claude.ts) ────────────────────────────────────

const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

// ── LLM call helpers ──────────────────────────────────────────────────────────

type HistoryEntry = { name: string; content: string; isSelf: boolean }
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Build the system prompt with a hard identity constraint at the very top.
 * The constraint must come FIRST so the model cannot ignore it.
 * otherParticipants lists the names of other agents/users in the room so the
 * model knows who it can @mention to continue the conversation.
 */
const LOCAL_MODEL_PLAN_FIRST = `

## Tool Use Discipline

Before calling any tool, check: do you already have this information from an earlier result in this conversation? If yes, use it — do not re-fetch.

When you do call tools:
1. State what you know and what you still need
2. Call one tool, read the result, then decide the next step
3. After gathering what you need, ACT — write the manifest, apply the change, or give your answer

When stuck: write what you know, what's blocking you, and ask the user — do not call more tools hoping for a better result.
Call list_tools(category) to discover what tools are available in a category.

## Critical Tool Call Rules

- **NEVER write a tool name or XML function tag in your text reply.** You MUST use the JSON tool_calls mechanism. Any tool name written as prose (e.g. "kubectl_get_pods") or XML (e.g. \`<function=kubectl_get>\`) will be ignored and treated as a hallucination.
- **Do NOT call tools in response to conversational messages**, greetings, or acknowledgements ("hello", "yes", "thanks", "it worked"). Only call tools when you need real data to complete a concrete task. If the message is conversational, reply in text only.
- **Do NOT repeat a tool call** you already made with the same arguments in this session. Cached results will be returned automatically — do not re-fetch unless explicitly asked.`

/**
 * Build a compact gateway tool category summary for injection into system prompts.
 * Shows category names and counts only — agents call list_tools(category) to drill in.
 */
function buildGatewayCategorySummary(gatewayTools: GatewayTool[]): string {
  if (gatewayTools.length === 0) return ''
  const byCategory = new Map<string, number>()
  for (const t of gatewayTools) {
    const cat = t.category ?? 'general'
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1)
  }
  const lines = ['\n\n## Gateway Tool Categories', 'Use list_tools(category) to see tool names in any category.']
  for (const [cat, count] of byCategory) {
    lines.push(`- **${cat}** (${count} tools)`)
  }
  return lines.join('\n')
}

function buildSystemPrompt(
  agentName: string,
  agentBasePrompt: string,
  otherParticipants: string[],
  hasTools: boolean | 'legacy' | 'mcp' = false,
  /** Compact category summary built from gateway tools — injected when tools are enabled */
  gatewayCategorySummary = '',
  /** Active room goal — when set, agent must respond with progress rather than going SILENT */
  activeGoal?: string,
): string {
  const othersLine = otherParticipants.length > 0
    ? `Other participants in this chat: ${otherParticipants.join(', ')}`
    : 'You are the only agent in this chat.'
  const mentionHint = otherParticipants.length > 0
    ? `To address or continue the conversation with another participant, use @TheirName in your reply (e.g. "@${otherParticipants[0]} what do you think?"). This will notify them and invite their response.`
    : ''
  const toolAddendum =
    hasTools === 'mcp'              ? '\n\n## ORION Tools\nYou have ORION management tools available via MCP. Use them — do not describe hypothetical actions when you can call a tool to get real data.' :
    hasTools === 'legacy' || hasTools === true ? TOOLS_SYSTEM_ADDENDUM :
    ''
  const planFirst = LOCAL_MODEL_PLAN_FIRST
  const silentRule = activeGoal
    ? `7. There is an ACTIVE GOAL in this room (see below). You MUST respond with progress or a status update. Do NOT reply SILENT while a goal is active.`
    : `7. If the conversation has naturally concluded or you have nothing meaningful to add, reply with exactly the single word: SILENT`
  const goalBlock = activeGoal
    ? `\n\n## Active Goal\n${activeGoal}\nYou must keep working toward this goal and report progress. Only stop when the goal is explicitly marked complete.`
    : ''
  return `IMPORTANT — YOUR ROLE:
You are ${agentName}. You are ONE participant in a group chat.
${othersLine}

Rules you must follow without exception:
1. Write ONE short reply as yourself only.
2. Do NOT write responses, speech, or dialogue for any other participant.
3. Do NOT use speaker labels like "${agentName}:" or any name prefix in your reply.
4. Do NOT write scripts, screenplays, or simulated multi-turn exchanges.
5. Do NOT invent what other participants might say next.
6. ${mentionHint}
${silentRule}

---
${agentBasePrompt}${toolAddendum}${gatewayCategorySummary}${planFirst}${goalBlock}`
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

/** Claude Code SDK — OAuth credentials, routed through orion-claude sidecar.
 *  When agentId + roomId are supplied, the sidecar writes a per-request .mcp.json
 *  so Claude can call ORION tools natively via MCP instead of going around the system. */
async function callClaude(
  agentName: string,
  agentBasePrompt: string,
  otherParticipants: string[],
  history: HistoryEntry[],
  latestMessage: string,
  modelId?: string,
  hasTools = false,
  agentId?: string,
  roomId?: string,
  activeGoal?: string,
): Promise<string | null> {
  // Always enable MCP when in a room context — Claude should have the same tool access
  // as OpenAI-compatible agents. maxTurns controls depth; hasTools controls prompt framing.
  const useMcp = !!agentId && !!roomId
  const toolMode: false | 'legacy' | 'mcp' = useMcp ? 'mcp' : hasTools ? 'legacy' : false
  const sys = buildSystemPrompt(agentName, agentBasePrompt, otherParticipants, toolMode, '', activeGoal)
  const historyBlock = history.length
    ? history.map(e => `${e.name}: ${e.content}`).join('\n') + '\n\n'
    : ''
  const prompt = historyBlock + latestMessage
  const res = await fetch(`${CLAUDE_URL}/run/collect`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      prompt,
      systemPrompt: sys,
      // MCP context: always enabled in rooms so Claude has the same tools as other agents.
      // maxTurns = maxToolRounds + 1 (the +1 guarantees a final response turn even if all tool rounds are used).
      // The OpenAI-compat path enforces this via a forced final call; the Claude/MCP path relies on maxTurns headroom.
      ...(useMcp ? { agentId, roomId, maxTurns: hasTools ? 6 : 3 } : { maxTurns: 1 }),
      ...(modelId ? { model: modelId } : {}),
    }),
    // MCP tool calls can take longer — allow 5 min for tool-using sessions
    signal: AbortSignal.timeout(useMcp ? 300_000 : 120_000),
  }).catch((e: Error) => { console.error(`[room-agents] orion-claude fetch failed: ${e.message}`); return null })
  if (!res?.ok) {
    console.error(`[room-agents] orion-claude /run/collect returned HTTP ${res?.status}`)
    return null
  }
  const data = await res.json() as { text?: string }
  return data.text?.trim() || null
}

/** Ollama native /api/chat endpoint */
async function callOllamaChat(
  agentName: string,
  agentBasePrompt: string,
  otherParticipants: string[],
  history: HistoryEntry[],
  latestMessage: string,
  model: string,
  baseUrl: string,
  hasTools = false,
  gatewayCategorySummary = '',
  activeGoal?: string,
): Promise<string | null> {
  const sys = buildSystemPrompt(agentName, agentBasePrompt, otherParticipants, hasTools, gatewayCategorySummary, activeGoal)
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

type OpenAIMessage = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

type OpenAICallResult = { reply: string | null; tokensUsed: number; contextLimit: number }

// ── Tool result cache ─────────────────────────────────────────────────────────

/**
 * Per-call tool result cache with TTL.
 * Prevents the model from re-fetching identical data within a single response session.
 *
 * TTL by category:
 *   kubectl_* (get, logs, pods)  — 30s  cluster state changes fast during deploys
 *   gitops_ls / gitops_read      — 60s  changes only on PR merge
 *   orion_get_environment        — 120s static config, rarely changes mid-session
 *   get_deployment_template      — ∞    templates are static, cache for full session
 *   write ops (propose, write)   — no cache, always execute
 */
const TOOL_CACHE_TTLS: Record<string, number> = {
  kubectl_get:          30_000,
  kubectl_get_pods:     30_000,
  kubectl_logs:         30_000,
  gitops_ls:            60_000,
  gitops_read:          60_000,
  orion_get_environment: 120_000,
  get_deployment_template: Infinity,
  list_tools:           Infinity,
}

/** Tools that are write operations — never cache, always execute */
const NO_CACHE_TOOLS = new Set([
  'gitops_propose', 'knowledge_write', 'propose_tool',
  'orion_create_agent', 'orion_update_agent', 'orion_archive_agent',
])

interface CacheEntry { result: string; expiresAt: number }

function makeToolCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}::${JSON.stringify(args, Object.keys(args).sort())}`
}

/**
 * Patterns that indicate the model wrote a tool call as prose instead of using
 * the JSON tool_calls mechanism. These replies must be discarded and the model
 * prompted to produce a real text response.
 */
const FAKE_TOOL_CALL_PATTERNS = [
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4}$/,           // bare snake_case tool name only
  /<function\s*=\s*\w+/i,                             // <function=kubectl_get> XML style
  /<tool_call>/i,                                     // <tool_call> XML block
  /^\s*\{?\s*"?function"?\s*:/i,                      // JSON function object as text
]

function isFakeToolCall(text: string): boolean {
  const t = text.trim()
  if (t.length > 200) return false  // real replies are longer
  return FAKE_TOOL_CALL_PATTERNS.some(p => p.test(t))
}

/** OpenAI-compatible /v1/chat/completions endpoint — supports tool calling */
async function callOpenAIChat(
  agentName: string,
  agentBasePrompt: string,
  otherParticipants: string[],
  history: HistoryEntry[],
  latestMessage: string,
  model: string,
  baseUrl: string,
  apiKey?: string | null,
  toolContext?: { roomId: string; agentId: string; llm: string; allowedTools?: Set<string> },
  gateway?: AgentGateway | null,
  gatewayTools?: GatewayTool[],
  activeGoal?: string,
): Promise<OpenAICallResult> {
  const hasTools = !!toolContext
  const gatewayCategorySummary = gatewayTools ? buildGatewayCategorySummary(gatewayTools) : ''
  const sys = buildSystemPrompt(agentName, agentBasePrompt, otherParticipants, hasTools, gatewayCategorySummary, activeGoal)
  const chatMsgs = buildChatMessages(history, latestMessage)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  // Discover context window size for this endpoint (cached after first call)
  const contextLimit = await getModelContextLimit(baseUrl)

  const messages: OpenAIMessage[] = [{ role: 'system', content: sys }, ...chatMsgs]

  // Registry tools — all tools available in chat context (the single source of truth)
  const registryTools = getToolsForContext('chat').map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
  const registryToolNames: Set<string> = new Set(getToolsForContext('chat').map(t => t.name))

  // Legacy agent-tools (create_task, orion_manage_task, etc.) — keep for backward compat.
  // Exclude any that are now in the registry to avoid duplicates.
  // buildToolDefinitions() injects real environment names into write_secret description.
  const allToolDefs = await buildToolDefinitions()
  const legacyTools = allToolDefs.filter(d => !registryToolNames.has(d.function.name))
  const legacyToolNames: Set<string> = new Set(legacyTools.map(d => d.function.name))

  // Merge: registry + legacy + gateway tools
  const allowedTools = toolContext?.allowedTools
  const merged = hasTools
    ? [
        ...registryTools,
        ...legacyTools,
        ...(gatewayTools ?? []).map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      ]
    : undefined
  // Apply per-agent allowlist if present (agents like Warden ship with a
  // narrow whitelist via contextConfig.allowedTools). If the whitelist is
  // present but empty (operator wants tools off), pass an empty array.
  const allTools = merged && allowedTools
    ? merged.filter(t => allowedTools.has(t.function.name))
    : merged

  // Names of ORION-native tools for dispatch routing (registry + legacy)
  const orionToolNames: Set<string> = new Set([...registryToolNames, ...legacyToolNames])

  // Gateway tool names — used to distinguish known gateway tools from hallucinated names.
  // Without this set, any hallucinated name silently falls through to the gateway client
  // and produces an opaque error instead of a useful "tool not found" message.
  const gatewayToolNames: Set<string> = new Set(gatewayTools?.map(t => t.name) ?? [])
  const allKnownToolNames: string[] = [...orionToolNames, ...gatewayToolNames]

  // Qwen3 models generate <think>…</think> tokens by default in Ollama. These thinking
  // tokens interfere with structured tool_calls output — the model occasionally narrates
  // the tool call as prose instead of emitting a proper tool_calls JSON block. Disabling
  // thinking mode via think:false fixes the inconsistency without removing reasoning ability.
  const isQwen3 = /qwen3/i.test(model)

  type Choice = { finish_reason: string; message: { role: string; content: string | null; tool_calls?: ToolCall[] } }
  type OpenAIResponse = { choices?: Choice[]; usage?: { prompt_tokens?: number } }

  let tokensUsed = 0

  // Per-session tool result cache — keyed by (toolName, args), evicted by TTL
  const toolCache = new Map<string, CacheEntry>()

  // Tool-call loop — keep going until the model produces a text reply
  const maxToolRoundsSetting = await prisma.systemSetting.findUnique({ where: { key: 'agent.chat.maxToolRounds' } })
  const MAX_TOOL_ROUNDS = parseInt(String(maxToolRoundsSetting?.value ?? '15'), 10) || 15
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: Record<string, unknown> = { model, stream: false, messages }
    if (allTools) body.tools = allTools
    if (isQwen3) body.think = false

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      console.error(`[room-agents] OpenAI-compat ${baseUrl} returned HTTP ${res.status}`)
      return { reply: null, tokensUsed, contextLimit }
    }

    const data = await res.json() as OpenAIResponse
    tokensUsed = data.usage?.prompt_tokens ?? tokensUsed
    const choice = data.choices?.[0]
    if (!choice) return { reply: null, tokensUsed, contextLimit }

    // Plain text reply — check for fake tool calls before accepting
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      const replyText = choice.message.content?.trim() || null
      // Fix #1: detect when the model wrote a tool call as prose instead of using tool_calls
      if (replyText && isFakeToolCall(replyText)) {
        console.warn(`[room-agents] ${agentName}: detected fake tool call in text reply: "${replyText}" — injecting correction`)
        messages.push({ role: 'assistant', content: replyText })
        messages.push({
          role: 'user',
          content: `Your last reply looked like a tool call written as plain text ("${replyText}"). ` +
            `Do NOT write tool names in your reply text. ` +
            `Use the JSON tool_calls mechanism to call tools, or write a real text reply if you have an answer.`,
        })
        continue  // burn a round to get a real response
      }
      return { reply: replyText, tokensUsed, contextLimit }
    }

    // Tool calls — execute each and feed results back
    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: choice.message.tool_calls })

    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }

      // Fix #2: check tool cache before executing (skip write ops)
      let result: string
      const cacheKey = makeToolCacheKey(tc.function.name, args)
      const ttl = TOOL_CACHE_TTLS[tc.function.name]
      const cached = !NO_CACHE_TOOLS.has(tc.function.name) && ttl !== undefined
        ? toolCache.get(cacheKey)
        : undefined

      if (cached && Date.now() < cached.expiresAt) {
        console.log(`[room-agents] ${agentName} tool cache hit: ${tc.function.name} (expires in ${Math.round((cached.expiresAt - Date.now()) / 1000)}s)`)
        result = `[Cached result — fetched earlier this session]\n${cached.result}`
      } else {
        console.log(`[room-agents] ${agentName} calling tool: ${tc.function.name}`, args)

        if (registryToolNames.has(tc.function.name)) {
          // Registry tool — single source of truth, consistent across all contexts
          result = await executeRegisteredTool(tc.function.name, args, {
            agentId: toolContext!.agentId,
            prisma,
            gateway: gateway ? {
              executeTool: (n, a) => gateway.client.executeTool(n, a),
              listTools: () => gateway.client.listTools(),
            } : undefined,
          })
        } else if (legacyToolNames.has(tc.function.name)) {
          // Legacy agent-tools (create_task, orion_manage_task, etc.)
          result = await executeTool(tc.function.name, args, {
            roomId:        toolContext!.roomId,
            callerAgentId: toolContext!.agentId,
            callerLlm:     toolContext!.llm,
          })
        } else if (gateway && gatewayToolNames.has(tc.function.name)) {
          // Known gateway tool
          result = await gateway.client.executeTool(tc.function.name, args)
        } else {
          // Hallucinated or unknown tool name — attempt fuzzy resolution before giving up.
          const resolved = resolveToolName(tc.function.name, allKnownToolNames)
          if (resolved?.confidence === 'high') {
            // Auto-correct: call the real tool without burning a round trip
            console.warn(`[room-agents] ${agentName}: auto-correcting hallucinated tool "${tc.function.name}" → "${resolved.name}"`)
            if (registryToolNames.has(resolved.name)) {
              result = await executeRegisteredTool(resolved.name, args, {
                agentId: toolContext!.agentId,
                prisma,
                gateway: gateway ? {
                  executeTool: (n, a) => gateway.client.executeTool(n, a),
                  listTools:   () => gateway.client.listTools(),
                } : undefined,
              })
            } else if (legacyToolNames.has(resolved.name)) {
              result = await executeTool(resolved.name, args, {
                roomId:        toolContext!.roomId,
                callerAgentId: toolContext!.agentId,
                callerLlm:     toolContext!.llm,
              })
            } else if (gateway) {
              result = await gateway.client.executeTool(resolved.name, args)
            } else {
              result = `[Auto-corrected "${tc.function.name}" → "${resolved.name}" but still could not execute]`
            }
            result = `[Note: corrected "${tc.function.name}" → "${resolved.name}"]\n${result}`
          } else {
            // Can't resolve — return the full tool list so the model can self-correct
            const toolList = await executeRegisteredTool('list_tools', {}, {
              agentId: toolContext!.agentId,
              prisma,
              gateway: undefined,
            }).catch(() => '')
            const suggestion = resolved ? ` Did you mean "${resolved.name}"?` : ''
            result = `Error: tool "${tc.function.name}" does not exist.${suggestion} Use the exact name from the list below — never guess.\n\n${toolList}`
          }
        }

        // Store in cache if this tool has a TTL
        if (ttl !== undefined && !NO_CACHE_TOOLS.has(tc.function.name)) {
          toolCache.set(cacheKey, {
            result,
            expiresAt: isFinite(ttl) ? Date.now() + ttl : Infinity,
          })
        }
      }

      console.log(`[room-agents] tool result: ${result}`)

      // Save as structured tool_call message and publish via SSE so it appears in real-time
      const safeOutput = result.replace(/(?:token|secret|password|key)\s*[=:]\s*\S+/gi, (m) => m.split(/[=:]/)[0] + ': [REDACTED]')
      const toolMsg = await prisma.chatMessage.create({
        data: {
          roomId:      toolContext!.roomId,
          agentId:     toolContext!.agentId,
          senderType:  'tool_call',
          content:     tc.function.name,
          attachments: { tool: tc.function.name, input: tc.function.arguments ?? '', output: safeOutput.slice(0, 2000) } as any,
        },
      }).catch(() => null)
      if (toolMsg) {
        await publishChatMessage(toolContext!.roomId, {
          id:          toolMsg.id,
          senderType:  'tool_call',
          content:     tc.function.name,
          attachments: { tool: tc.function.name, input: tc.function.arguments ?? '', output: safeOutput.slice(0, 2000) },
          sender:      { type: 'agent', id: toolContext!.agentId, name: agentName },
          createdAt:   toolMsg.createdAt instanceof Date ? toolMsg.createdAt.toISOString() : toolMsg.createdAt,
        })
      }

      messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name })
    }
  }

  // Tool rounds exhausted — force one final response turn with no tools available
  // so the agent always replies with what it learned, never silently disappears.
  console.warn(`[room-agents] ${agentName} hit MAX_TOOL_ROUNDS — forcing final response turn`)
  const finalBody: Record<string, unknown> = { model, stream: false, messages }
  if (isQwen3) finalBody.think = false
  // Omit tools entirely so the model must produce a text reply
  const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(finalBody),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null)
  if (!finalRes?.ok) return { reply: null, tokensUsed, contextLimit }
  const finalData = await finalRes.json() as OpenAIResponse
  tokensUsed = finalData.usage?.prompt_tokens ?? tokensUsed
  return { reply: finalData.choices?.[0]?.message?.content?.trim() || null, tokensUsed, contextLimit }
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
 * Safety guard: if this many agent messages have been saved in the last minute
 * for a room, stop chaining to prevent a runaway loop.
 */
const MAX_AGENT_MESSAGES_PER_MINUTE = 40
/** Maximum agent→agent chain hops per human message to prevent infinite loops. */
const MAX_CHAIN_DEPTH = 4

/**
 * Trigger agent replies for a chat room message (fire-and-forget from POST handler).
 *
 * Routing:
 * - @mention present → only mentioned agents reply
 * - No @mention      → all agent members reply
 *
 * After each round, chaining continues ONLY on explicit @mentions (bare name
 * references are ignored — they cause false-positive loops). It stops when:
 *   1. No @mention appears in the last reply (natural end of conversation), or
 *   2. An agent replies with the single word SILENT, or
 *   3. The room has exceeded MAX_AGENT_MESSAGES_PER_MINUTE (rate-limit guard), or
 *   4. Chain depth exceeds MAX_CHAIN_DEPTH (loop guard).
 */
export async function triggerRoomAgentReplies(
  roomId: string,
  triggerContent: string,
  chainDepth = 0,
): Promise<void> {
  // Chain depth guard — stop before agents can loop indefinitely
  if (chainDepth > MAX_CHAIN_DEPTH) {
    console.warn(`[room-agents] room ${roomId} hit MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH}) — stopping chain`)
    return
  }

  // Runaway loop guard — count agent messages in this room in the last minute
  const recentAgentCount = await prisma.chatMessage.count({
    where: {
      roomId,
      senderType: 'agent',
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
  })
  if (recentAgentCount >= MAX_AGENT_MESSAGES_PER_MINUTE) {
    console.warn(`[room-agents] room ${roomId} hit rate limit (${recentAgentCount} agent msgs/min) — stopping chain`)
    return
  }
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        where: { agentId: { not: null } },
        include: { agent: true },
      },
    },
  })

  const memberRecords = (room?.members ?? [])
    .filter((m: any) => m.agent && (m.agent.metadata as Record<string, unknown> | null)?.archived !== true)
  const agentMembers = memberRecords.map((m: any) => m.agent!)
  if (agentMembers.length === 0) return

  // ── Ring Leader routing ──────────────────────────────────────────────────────
  // If the room has a ring leader configured and no @mention targets specific agents,
  // only the ring leader auto-replies. The ring leader then decides whether to
  // delegate to specialists or answer directly.
  const roomMeta = (room?.metadata ?? {}) as Record<string, unknown>
  const ringLeaderId = roomMeta?.ringLeaderAgentId as string | undefined
  // TODO: remove metadata.activeGoal fallback — deprecated in favour of RoomGoal table
  const activeGoalRecord = await prisma.roomGoal.findFirst({
    where: { roomId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  const activeGoal = activeGoalRecord?.text
  const mentionedNames  = parseMentions(triggerContent)
  const isEveryone      = mentionedNames.some(n => n.toLowerCase() === 'everyone')
  const isDirect        = agentMembers.length === 1  // 1-on-1 room — always reply
  const hasSpecificMention = mentionedNames.length > 0 && !isEveryone

  let triggeredAgents: typeof agentMembers

  // @everyone bypasses ring leader — targets all agents
  if (isEveryone) {
    triggeredAgents = agentMembers
  } else if (!hasSpecificMention && ringLeaderId) {
    // Ring leader mode — only the ring leader responds to non-mentioned messages
    const ringLeader = agentMembers.find((a: any) => a.id === ringLeaderId)
    triggeredAgents = ringLeader ? [ringLeader] : agentMembers.filter((a: any) => {
      const cc = ((a.metadata ?? {}) as Record<string, unknown>).contextConfig as Record<string, unknown> | undefined
      return !cc?.watchPrompt
    })
  } else if (hasSpecificMention) {
    // @AgentName pings specific agents — always deliver, bypassing ring leader
    triggeredAgents = agentMembers.filter((a: any) =>
      mentionedNames.some(n => a.name.toLowerCase() === n.toLowerCase()),
    )
  } else if (isDirect) {
    triggeredAgents = agentMembers
  } else {
    // No explicit ring leader set — fall back to role='lead' (first agent added to room).
    // This handles rooms created before ringLeaderAgentId was wired up.
    const leadAgents = agentMembers.filter((a: any) => {
      const member = memberRecords.find((m: any) => m.agentId === a.id)
      return member?.role === 'lead'
    })
    triggeredAgents = leadAgents.length > 0 ? leadAgents : agentMembers.filter((a: any) => {
      const cc = ((a.metadata ?? {}) as Record<string, unknown>).contextConfig as Record<string, unknown> | undefined
      return !cc?.watchPrompt
    })
  }

  if (triggeredAgents.length === 0) return

  // Pre-fetch specialists list (for ring leader prompt)
  const specialists = await prisma.agentProfile.findMany({
    select: { agentId: true, domain: true, description: true, tags: true, confidence: true, agent: { select: { name: true } } },
  })

  // Build ring leader context: specialists list + load ring-leader template
  let ringLeaderContext = ''
  if (ringLeaderId && specialists.length > 0) {
    const specialistLines = specialists.map(s =>
      `  • ${s.agent.name} (${s.domain}) — ${s.description}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`,
    )
    ringLeaderContext = `## Specialist Agents Available to You\n\nYou can delegate work to these specialist agents:\n\n${specialistLines.join('\n')}\n\nIf a question falls outside your expertise, delegate it using the \`delegate\` tool.`

    try {
      const ringLeaderTemplate = await getPrompt('system.ring-leader')
      // Inject the specialists section
      ringLeaderContext = ringLeaderTemplate.replace(
        /## Specialist Agents Available to You\s*\n\nYou can delegate work to these specialist agents:\s*\n\n.*?(?=\n\n## How to Delegate)/s,
        `## Specialist Agents Available to You\n\nYou can delegate work to these specialist agents:\n\n${specialistLines.join('\n')}\n\n`,
      )
    } catch { /* template not available — use built specialist lines */ }
  } else if (ringLeaderId) {
    ringLeaderContext = `\n\nNo specialist agents are currently registered. Handle all questions yourself without delegation.`
  }

  // ── Pre-loop context setup ────────────────────────────────────────────────────
  // Find the last compaction boundary and read settings once — shared across all agents.
  const lastCompaction = await prisma.chatMessage.findFirst({
    where: { roomId, senderType: 'compaction' },
    orderBy: { createdAt: 'desc' },
  })
  // Safety cap for the DB query — compaction is the real context limit, not message count.
  // At ~200-500 tokens/message and a 256K context window, compaction fires well before 1000 messages.
  const histTake = 1000

  // Track token count across agents in this turn; start from room's stored value
  let currentTokenCount = room?.tokenCount ?? 0
  const roomTokenLimit: number | null = room?.tokenLimit ?? null
  // Once compaction fires for this room in this turn, skip token writes for subsequent agents
  // (their prompt_tokens reflect pre-compaction context and would re-trigger the threshold)
  let compactedThisTurn = false

  let lastSavedReply: string | null = null

  for (const agent of triggeredAgents) {
    try {
      // Re-fetch history each iteration so each agent sees the previous agent's reply.
      // Start from the most recent compaction boundary if one exists — this keeps the
      // LLM context bounded and ensures the compaction summary is always included.
      const recentMessages = await prisma.chatMessage.findMany({
        where: {
          roomId,
          ...(lastCompaction ? { createdAt: { gte: lastCompaction.createdAt } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: histTake,
        include: {
          agent: { select: { id: true, name: true } },
          user:  { select: { username: true, name: true } },
        },
      })
      recentMessages.reverse()

      // All messages except the very last are history context.
      // The very last message is what this agent is directly responding to.
      const historyMsgs = recentMessages.slice(0, -1).filter((m: any) => m.senderType !== 'system')
      const lastMsg     = recentMessages[recentMessages.length - 1]
      const lastSender  = lastMsg?.agent?.name ?? lastMsg?.user?.name ?? lastMsg?.user?.username ?? 'User'
      const latestTurn  = lastMsg ? `${lastSender}: ${lastMsg.content}` : triggerContent

      // Build structured history with isSelf flag so LLMs can use proper role assignments.
      // Compaction messages appear as [Summary] — they are the summarised prior context.
      const history: HistoryEntry[] = historyMsgs.map((m: any) => ({
        name:   m.senderType === 'compaction' ? '[Summary]' : (m.agent?.name ?? m.user?.name ?? m.user?.username ?? 'User'),
        content: m.content,
        isSelf: m.agentId === agent.id,
      }))

      const meta          = (agent.metadata ?? {}) as Record<string, unknown>
      const contextConfig = (meta.contextConfig ?? {}) as Record<string, unknown>
      const rawPrompt     = meta.systemPrompt as string | undefined
      const llm           = (contextConfig.llm as string | undefined) ?? 'claude:claude-haiku-4-5-20251001'
      const toolsEnabled  = !!(contextConfig.tools)

      // Base persona description — identity constraint is added by buildSystemPrompt()
      let personaPrompt = rawPrompt
        ? `${agent.role ? `Role: ${agent.role}\n\n` : ''}${rawPrompt}`
        : `${agent.role ? `Role: ${agent.role}\n\n` : ''}${agent.description ?? ''}`

      // Ring Leader context injection — append before agentContext so it appears early
      if (agent.id === ringLeaderId && ringLeaderContext) {
        personaPrompt += ringLeaderContext
      }

      // Inject pre-fetched context (ORION snapshot + vector search) so agents arrive
      // pre-oriented and don't need to call orion_get_snapshot on every message.
      const [agentContext, agentLocalContext, roomLocalContext] = await Promise.all([
        buildAgentContext(latestTurn),
        buildAgentLocalContext(agent.id),
        buildRoomLocalContext(roomId),
      ])
      const contextParts = [personaPrompt]
      if (agentContext)      contextParts.push(agentContext)
      if (agentLocalContext) contextParts.push(agentLocalContext)
      if (roomLocalContext)  contextParts.push(roomLocalContext)
      const agentBasePrompt = contextParts.join('\n\n')

      // Names of other agents/users in the room so the model can @mention them
      const otherParticipants = agentMembers
        .filter((a: any) => a.id !== agent.id)
        .map((a: any) => a.name)

      // Optional tool whitelist — when an agent's contextConfig.allowedTools is
      // present, only those tools are exposed (defense in depth: a jailbroken
      // agent can't reach tools outside its whitelist). Backwards compatible:
      // agents without `allowedTools` see the full registry as before.
      const allowedTools = Array.isArray(contextConfig.allowedTools)
        ? new Set((contextConfig.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string'))
        : undefined

      // Tool context passed to OpenAI-compatible calls when tools are enabled
      const toolContext = toolsEnabled
        ? { roomId, agentId: agent.id, llm, allowedTools }
        : undefined

      // Resolve gateway from the agent's linked environment (same tools regardless of execution context)
      const gateway = toolsEnabled ? await resolveAgentGateway(agent.id) : null
      const gatewayTools = gateway ? await gateway.client.listTools().catch(() => []) : []

      // Warn the agent if tools are enabled but no environment is linked — gateway tools (kubectl, shell, etc.)
      // will be invisible and the agent would otherwise burn turns trying to propose them.
      if (toolsEnabled && !gateway) {
        personaPrompt += `\n\n⚠️ WARNING: You have tools enabled but are not linked to any environment. Built-in gateway tools (kubectl_logs, kubectl_get, shell_exec, docker_ps, etc.) are unavailable until an admin links this agent to an environment. Do not request these tools — instead, inform the user that you need to be linked to an environment first.`
      }


      console.log(`[room-agents] ${agent.name} (${llm}${toolsEnabled ? ', tools' : ''}${gateway ? ', gateway' : ''}) → replying to room ${roomId}`)

      let reply: string | null = null
      let tokensUsed = 0
      let discoveredContextLimit = 0

      setTyping(roomId, agent.name)
      try {
        if (llm.startsWith('ext:')) {
          const extId  = llm.slice('ext:'.length)
          const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
          if (!extModel) {
            console.error(`[room-agents] ext model ${extId} not found`)
            continue
          }
          const baseUrl = extModel.baseUrl ?? 'http://localhost:11434'
          if (extModel.provider === 'ollama') {
            // Route through OpenAI-compat endpoint so tool_calls JSON is supported.
            // Ollama's native /api/chat has no tools array — callOllamaChat can't handle tools.
            const result = await callOpenAIChat(agent.name, agentBasePrompt, otherParticipants, history, latestTurn, extModel.modelId, baseUrl, extModel.apiKey ?? null, toolContext, gateway, gatewayTools, activeGoal)
            reply = result.reply
            tokensUsed = result.tokensUsed
            discoveredContextLimit = result.contextLimit
          } else {
            // openai / custom — OpenAI-compatible (supports tool calling + token tracking)
            const result = await callOpenAIChat(agent.name, agentBasePrompt, otherParticipants, history, latestTurn, extModel.modelId, baseUrl, extModel.apiKey, toolContext, gateway, gatewayTools, activeGoal)
            reply = result.reply
            tokensUsed = result.tokensUsed
            discoveredContextLimit = result.contextLimit
          }
        } else if (llm.startsWith('ollama:')) {
          const model   = llm.slice('ollama:'.length)
          const baseUrl = await resolveOllamaBaseUrl()
          // Route through OpenAI-compat endpoint (/v1/chat/completions) so tool_calls
          // JSON is supported. Ollama's /api/chat has no tools array — agents on that
          // path can only hallucinate tool names as prose.
          const result = await callOpenAIChat(agent.name, agentBasePrompt, otherParticipants, history, latestTurn, model, baseUrl, null, toolContext, gateway, gatewayTools, activeGoal)
          reply = result.reply
          tokensUsed = result.tokensUsed
          discoveredContextLimit = result.contextLimit
        } else if (llm.startsWith('gemini:')) {
          // Gemini not yet supported — reject clearly instead of silently falling back to Claude
          console.error(`[room-agents] ${agent.name}: gemini:* models are not yet supported (got "${llm}")`)
          const notice = `I'm configured to use a Gemini model (\`${llm}\`) which isn't supported yet. Please update my model setting to a Claude or Ollama model.`
          const msg = await prisma.chatMessage.create({
            data: { roomId, agentId: agent.id, senderType: 'agent', content: notice },
            include: {
              agent: { select: { id: true, name: true } },
              user:  { select: { id: true, username: true, name: true } },
            },
          })
          await publishChatMessage(roomId, {
            id:         msg.id,
            senderType: 'agent',
            content:    notice,
            sender:     { type: 'agent', id: agent.id, name: agent.name },
            createdAt:  msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
          })
          continue
        } else {
          // claude / claude:<model> — routed through orion-claude sidecar.
          // When tools are enabled, the sidecar writes a per-request .mcp.json so Claude
          // calls ORION tools natively via MCP (ORION is the harness, Claude is the brain).
          const claudeModel = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
          reply = await callClaude(agent.name, agentBasePrompt, otherParticipants, history, latestTurn, claudeModel, !!toolContext, agent.id, roomId, activeGoal)
          if (reply === null) {
            // Claude is unavailable — post a message on the agent's behalf rather than silently skipping
            console.warn(`[room-agents] ${agent.name}: Claude unavailable, posting unavailability notice`)
            const notice = `I'm currently unavailable — the Claude service is unreachable or out of credits. Please try again shortly.`
            const msg = await prisma.chatMessage.create({
              data: { roomId, agentId: agent.id, senderType: 'agent', content: notice },
              include: {
                agent: { select: { id: true, name: true } },
                user:  { select: { id: true, username: true, name: true } },
              },
            })
            await publishChatMessage(roomId, {
              id:         msg.id,
              senderType: 'agent',
              content:    notice,
              sender:     { type: 'agent', id: agent.id, name: agent.name },
              createdAt:  msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
            })
            continue
          }
        }
      } finally {
        clearTyping(roomId, agent.name)
      }

      if (!reply) {
        console.warn(`[room-agents] ${agent.name} returned empty reply`)
        continue
      }
      if (reply.trim().toUpperCase() === 'SILENT') {
        if (activeGoal) {
          // Goal is active — SILENT is not allowed. Post a status nudge so the user
          // knows the agent is still on the hook, then keep the goal visible.
          console.warn(`[room-agents] ${agent.name} tried SILENT with active goal — forcing status reply`)
          reply = `Still working on the goal: "${activeGoal}" — what's the current status?`
        } else {
          console.log(`[room-agents] ${agent.name} chose not to respond`)
          continue
        }
      }

      const message = await prisma.chatMessage.create({
        data: { roomId, agentId: agent.id, senderType: 'agent', content: reply },
        include: {
          agent: { select: { id: true, name: true } },
          user: { select: { id: true, username: true, name: true } },
        },
      })
      await prisma.chatRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } })

      // Publish to Redis for real-time SSE delivery
      const sender = message.agent
        ? { type: 'agent' as const, id: message.agent.id, name: message.agent.name }
        : message.user
        ? { type: 'user' as const, id: message.user.id, name: message.user.name || message.user.username }
        : { type: 'system' as const, id: null, name: 'System' }

      await publishChatMessage(roomId, {
        id: message.id,
        senderType: message.senderType,
        content: message.content,
        attachments: message.attachments,
        sender,
        createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
      })

      console.log(`[room-agents] ${agent.name} replied (${reply.length} chars)`)
      lastSavedReply = reply

      // ── Token tracking + compaction threshold checks ──────────────────────────
      // Only update when we have actual token usage (OpenAI-compat ext: models).
      // Skip if compaction already fired this turn — subsequent agents' prompt_tokens
      // reflect pre-compaction context and would incorrectly re-trigger the threshold.
      if (tokensUsed > 0 && !compactedThisTurn) {
        currentTokenCount = tokensUsed  // prompt_tokens is cumulative context size for this turn
        const effectiveLimit = roomTokenLimit ?? (discoveredContextLimit > 0 ? discoveredContextLimit : 0)
        await prisma.chatRoom.update({
          where: { id: roomId },
          data: { tokenCount: currentTokenCount, updatedAt: new Date() },
        })
        if (effectiveLimit > 0) {
          const pct = currentTokenCount / effectiveLimit
          console.log(`[room-agents] room ${roomId}: ${currentTokenCount}/${effectiveLimit} tokens (${Math.round(pct * 100)}%)`)
          if (pct >= 0.9) {
            console.warn(`[room-agents] room ${roomId}: context at ${Math.round(pct * 100)}% — auto-compacting`)
            try {
              await compactRoom(roomId)
              currentTokenCount = 0
              compactedThisTurn = true
              await prisma.chatRoom.update({
                where: { id: roomId },
                data: { tokenCount: 0, updatedAt: new Date() },
              })
            } catch (err) {
              console.error(`[room-agents] auto-compact failed: ${err instanceof Error ? err.message : String(err)}`)
              // tokenCount stays at the high value so the threshold re-triggers next turn
            }
          } else if (pct >= 0.7) {
            // Only warn once per 70% crossing — check if last system message is already a warning
            const lastSystemMsg = await prisma.chatMessage.findFirst({
              where: { roomId, senderType: 'system' },
              orderBy: { createdAt: 'desc' },
            })
            const lastAtt = lastSystemMsg?.attachments as Record<string, unknown> | null
            if (typeof lastAtt?.type !== 'string' || lastAtt.type !== 'compaction-warning') {
              await publishCompactionWarning(roomId, pct, currentTokenCount, effectiveLimit).catch(() => null)
            }
          }
          await publishTokenUpdate(roomId, currentTokenCount, effectiveLimit)
        }
      }
    } catch (e) {
      console.error(`[room-agents] ${agent.name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Chain: only on explicit @mentions in the last reply.
  // Bare name references ("Alpha already handled this") are intentionally ignored —
  // they cause false-positive loops where agents keep mentioning each other in passing.
  if (lastSavedReply) {
    const mentionedNames = parseMentions(lastSavedReply)
    const addressed = agentMembers.filter((a: any) =>
      mentionedNames.some((n: string) => a.name.toLowerCase() === n.toLowerCase()),
    )
    if (addressed.length > 0) {
      const syntheticTrigger = addressed.map((a: any) => `@${a.name}`).join(' ')
      console.log(`[room-agents] chaining to: ${addressed.map((a: any) => a.name).join(', ')} (depth ${chainDepth + 1})`)
      await triggerRoomAgentReplies(roomId, syntheticTrigger, chainDepth + 1)
    }
  }
}
