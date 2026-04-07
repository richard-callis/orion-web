import fs from 'fs'
import path from 'path'
import { prisma } from './db'
import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-code'

// Tool allowlist — read-only kubectl only
export const ALLOWED_TOOLS = [
  'Bash(kubectl get:*)',
  'Bash(kubectl describe:*)',
  'Bash(kubectl logs:*)',
  'Bash(kubectl top:*)',
]

function getSystemPrompt(): string {
  const claudeMdPath = process.env.CLAUDE_MD_PATH ?? '/claude-config/CLAUDE.md'
  let clusterContext = ''
  try {
    clusterContext = fs.readFileSync(claudeMdPath, 'utf8')
  } catch {
    clusterContext = '# K3s Homelab — context file not mounted'
  }

  return `You are Mission Control, an AI assistant managing a production K3s homelab cluster.

${clusterContext}

CRITICAL RESTRICTIONS:
- You may ONLY run: kubectl get, kubectl describe, kubectl logs, kubectl top
- NEVER run: kubectl delete, kubectl exec, kubectl apply, kubectl create, kubectl patch, rm, curl to external hosts
- NEVER suggest destructive operations without explicit user confirmation
- Always include namespace (-n flag) in kubectl commands`
}

function getPlanningSystemPrompt(targetType: string): string {
  const claudeMdPath = process.env.CLAUDE_MD_PATH ?? '/claude-config/CLAUDE.md'
  let clusterContext = ''
  try { clusterContext = fs.readFileSync(claudeMdPath, 'utf8') } catch { clusterContext = '# K3s Homelab — context file not mounted' }

  const scope = targetType === 'epic' ? 'high-level epic (will be broken into features)'
    : targetType === 'feature' ? 'feature (will be broken into backlog tasks)'
    : 'task (concrete implementation steps)'

  return `You are Mission Control, a technical planning assistant for a K3s homelab infrastructure project.

${clusterContext}

CRITICAL RESTRICTIONS (always enforced):
- You may ONLY run: kubectl get, kubectl describe, kubectl logs, kubectl top
- NEVER run: kubectl delete, kubectl exec, kubectl apply, kubectl create, kubectl patch, rm, or curl to external hosts
- Always include namespace (-n flag) in kubectl commands

PLANNING MODE — you are creating a plan for a ${scope}:
- Run kubectl commands freely to inspect the cluster and gather information before planning
- Ask clarifying questions if you genuinely need more information to produce a good plan
- When you have gathered enough information and are ready to write the final plan, produce it in full:
  - Use clear sections: Overview, Implementation Steps, Technical Details, Risks & Mitigations
  - Be specific and actionable — this plan will be saved and used to auto-generate ${targetType === 'epic' ? 'features' : 'tasks'}
  - Do NOT end the plan itself with open-ended questions like "What would you like to prioritize?" — the plan should be complete and self-contained`
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error'
  content?: string
  tool?: string
  input?: string
  output?: string
  error?: string
}

// Collect all text from a query() response into a single string
type AnyMsg = { type: string; message?: { content: Array<{ type: string; text?: string }> }; subtype?: string; result?: string }

async function collectQueryText(response: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const raw of response) {
    const msg = raw as AnyMsg
    if (msg.type === 'assistant' && msg.message) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) text += block.text
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result && !text.includes(msg.result.trim())) {
      text += msg.result
    }
  }
  return text.trim()
}

function getOAuthToken(): string | null {
  // Try the CLAUDE_CREDENTIALS env var first (raw JSON blob set by ESO)
  if (process.env.CLAUDE_CREDENTIALS) {
    try {
      const parsed = JSON.parse(process.env.CLAUDE_CREDENTIALS)
      const token = parsed?.claudeAiOauth?.accessToken
      if (token) return token
    } catch { /* fall through */ }
  }
  // Fall back to mounted credentials file
  const candidates = [
    process.env.CLAUDE_CREDENTIALS_PATH
      ? path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      : null,
    '/tmp/claude-home/.claude/.credentials.json',
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const token = parsed?.claudeAiOauth?.accessToken
      if (token) return token
    } catch { /* try next */ }
  }
  return null
}

export interface AgentContextConfig {
  maxTurns?: number        // default 6 for agent chats
  historyMessages?: number // default 6 for agent chats
  allowedTools?: string[]  // default [] (no tools) for agent chats
  summarizeAfter?: number  // summarize conversation after this many messages (default 20)
  llm?: string             // "claude:<model-id>" | "ollama:<model-id>" | "gemini:<model-id>" | "ext:<cuid>" — defaults to Claude Sonnet
}

export async function* streamOllamaChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  baseUrl?: string,
): AsyncGenerator<StreamChunk> {
  yield* streamOllamaAgentChat(prompt, conversationId, getSystemPrompt(), history, model, baseUrl)
}

export async function* streamAgentChat(
  prompt: string,
  conversationId: string,
  agentSystemPrompt: string,
  previousMessages: Array<{ role: string; content: string }> = [],
  contextConfig: AgentContextConfig = {},
): AsyncGenerator<StreamChunk> {
  const historyLimit   = contextConfig.historyMessages ?? 6
  const summarizeAfter = contextConfig.summarizeAfter  ?? 20
  const llm            = contextConfig.llm             ?? 'claude'

  const trimmedHistory = await maybeGetSummarizedHistory(
    conversationId, previousMessages, summarizeAfter, historyLimit
  )

  if (llm.startsWith('ollama:')) {
    const model = llm.slice('ollama:'.length)
    yield* streamOllamaAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, model)
    return
  }

  if (llm.startsWith('gemini:')) {
    const model = llm.slice('gemini:'.length)
    yield* streamGeminiAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, model)
    return
  }

  if (llm.startsWith('ext:')) {
    const extId = llm.slice('ext:'.length)
    const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
    if (!extModel) {
      yield { type: 'error', error: `External model not found: ${extId}` }
      return
    }
    if (extModel.provider === 'ollama') {
      yield* streamOllamaAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, extModel.modelId, extModel.baseUrl, extModel.timeoutSecs ?? 120)
      return
    }
    yield { type: 'error', error: `Unsupported external model provider: ${extModel.provider}` }
    return
  }

  // Claude path — claude:<model-id> or bare 'claude' (default)
  const claudeModel  = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
  const maxTurns     = contextConfig.maxTurns    ?? 6
  const allowedTools = contextConfig.allowedTools ?? []

  const overridePrompt = `You are NOT Claude Code and NOT the Claude CLI. Do not mention or reference Claude Code, Anthropic's CLI, or any developer tooling.

${agentSystemPrompt}

Respond only in the persona described above. Never break character or refer to yourself as Claude Code.`

  yield* streamClaudeResponse(prompt, conversationId, trimmedHistory, null, overridePrompt, {
    maxTurns,
    allowedTools,
    ...(claudeModel && { model: claudeModel }),
  })
}

async function* streamOllamaAgentChat(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  resolvedBaseUrl?: string,  // pre-resolved from ext: lookup — skips second DB query
  resolvedTimeoutSecs?: number,
): AsyncGenerator<StreamChunk> {
  let ollamaUrl = resolvedBaseUrl
  let timeoutSecs = resolvedTimeoutSecs ?? 120
  if (!ollamaUrl) {
    const extModel = await prisma.externalModel.findFirst({
      where: { provider: 'ollama', modelId: model, enabled: true },
    }) ?? await prisma.externalModel.findFirst({
      where: { provider: 'ollama', enabled: true },
    })
    if (!extModel) throw new Error('No Ollama model configured — add one in Admin → Models')
    ollamaUrl = extModel.baseUrl
    timeoutSecs = extModel.timeoutSecs ?? 120
  }
  const start = Date.now()
  let totalText = ''

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    { role: 'user', content: prompt },
  ]

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: AbortSignal.timeout(timeoutSecs * 1000),
    })

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
    if (!res.body) throw new Error('No response body from Ollama')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
          const text = chunk.message?.content ?? ''
          if (text) {
            totalText += text
            yield { type: 'text', content: text }
          }
        } catch { /* skip malformed line */ }
      }
    }

    const MAX_STORE_CHARS = 4000
    const savedContent = totalText.length > MAX_STORE_CHARS
      ? totalText.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : totalText

    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: `Ollama error: ${msg}` }
  }
}

export async function* streamGeminiChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
): AsyncGenerator<StreamChunk> {
  yield* streamGeminiAgentChat(prompt, conversationId, getSystemPrompt(), history, model)
}

async function* streamGeminiAgentChat(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    yield { type: 'error', error: 'Gemini API key not configured — add GEMINI_API_KEY to Vault secret/mission-control' }
    return
  }

  const start = Date.now()
  let totalText = ''

  const contents = [
    ...history.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: prompt }] },
  ]

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
      signal: AbortSignal.timeout(120000),
    })

    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
    if (!res.body) throw new Error('No response body from Gemini')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data) continue
        try {
          const chunk = JSON.parse(data) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          }
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          if (text) {
            totalText += text
            yield { type: 'text', content: text }
          }
        } catch { /* skip malformed line */ }
      }
    }

    const MAX_STORE_CHARS = 4000
    const savedContent = totalText.length > MAX_STORE_CHARS
      ? totalText.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : totalText

    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: `Gemini error: ${msg}` }
  }
}

// Summarize old messages and store the summary on the conversation.
// Returns [summary context message] + last N recent messages.
async function maybeGetSummarizedHistory(
  conversationId: string,
  messages: Array<{ role: string; content: string }>,
  summarizeAfter: number,
  recentCount: number,
): Promise<Array<{ role: string; content: string }>> {
  if (messages.length <= recentCount) return messages

  // Check if we already have a stored summary
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { metadata: true },
  })
  const meta = (convo?.metadata ?? {}) as Record<string, unknown>

  // Summarize if we're over the threshold and don't have a fresh summary
  const summarizedUpTo = meta.summarizedUpTo as number | undefined
  const needsSummary = messages.length >= summarizeAfter &&
    (summarizedUpTo === undefined || messages.length - summarizedUpTo > summarizeAfter / 2)

  if (needsSummary) {
    const toSummarize = messages.slice(0, -recentCount)
    const summaryText = await generateSummary(toSummarize)
    if (summaryText) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: {
            ...meta,
            contextSummary: summaryText,
            summarizedUpTo: messages.length - recentCount,
          },
        },
      })
      return [
        { role: 'user', content: `[Previous conversation summary]\n${summaryText}` },
        { role: 'assistant', content: 'Understood, I have reviewed the conversation history.' },
        ...messages.slice(-recentCount),
      ]
    }
  }

  // Use existing summary if available
  if (meta.contextSummary) {
    return [
      { role: 'user', content: `[Previous conversation summary]\n${meta.contextSummary as string}` },
      { role: 'assistant', content: 'Understood, I have reviewed the conversation history.' },
      ...messages.slice(-recentCount),
    ]
  }

  return messages.slice(-recentCount)
}

async function generateSummary(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  if (messages.length === 0) return null
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`)
    .join('\n\n')

  const ollamaExt = await prisma.externalModel.findFirst({
    where: { provider: 'ollama', enabled: true },
  })

  // Try Ollama first — free, local, no Claude quota
  if (ollamaExt) try {
    const res = await fetch(`${ollamaExt.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaExt.modelId,
        prompt: `Summarize this conversation in 3-5 sentences, capturing key decisions, context, and outcomes:\n\n${transcript}`,
        stream: false,
        system: 'You are a conversation summarizer. Produce a concise factual summary. Be brief.',
        options: { temperature: 0.1, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) {
      const data = await res.json() as { response?: string }
      if (data.response?.trim()) return data.response.trim()
    }
  } catch { /* Ollama unavailable — fall through to Claude */ }

  // Fallback: use Claude Code SDK (costs quota)
  try {
    if (process.env.CLAUDE_CREDENTIALS_PATH) {
      const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      const dest = '/tmp/claude-home/.claude/.credentials.json'
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (fs.existsSync(srcCreds)) fs.copyFileSync(srcCreds, dest)
    }
    const { query } = await import('@anthropic-ai/claude-code')
    const response = query({
      prompt: `Summarize this conversation concisely in 3-5 sentences, capturing key decisions, context, and outcomes:\n\n${transcript}`,
      options: { allowedTools: [], maxTurns: 1, customSystemPrompt: 'You are a conversation summarizer. Produce a concise factual summary.' },
    })
    const summary = await collectQueryText(response as AsyncIterable<unknown>)
    return summary || null
  } catch {
    return null
  }
}

export async function* streamClaudeResponse(
  prompt: string,
  conversationId: string,
  previousMessages: Array<{ role: string; content: string }> = [],
  planTarget?: { type: string; id: string } | null,
  agentSystemPrompt?: string,
  overrides?: { maxTurns?: number; allowedTools?: string[]; model?: string }
): AsyncGenerator<StreamChunk> {
  const start = Date.now()
  const toolsUsed: string[] = []
  let totalText = ''
  const toolCallLog: Array<{ tool: string; input: string; output?: string }> = []

  try {
    const { query } = await import('@anthropic-ai/claude-code')

    // Claude Code needs a writable HOME to store state (.claude.json).
    // The Secret volume is read-only, so copy creds to /tmp and point HOME there.
    if (process.env.CLAUDE_CREDENTIALS_PATH) {
      const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      const claudeHome = '/tmp/claude-home'
      const destDir = path.join(claudeHome, '.claude')
      fs.mkdirSync(destDir, { recursive: true })
      try { fs.copyFileSync(srcCreds, path.join(destDir, '.credentials.json')) } catch { /* ignore if missing */ }
      process.env.HOME = claudeHome
    }

    const systemPrompt = agentSystemPrompt ?? (planTarget ? getPlanningSystemPrompt(planTarget.type) : getSystemPrompt())

    const fullPrompt = previousMessages.length > 0
      ? previousMessages.map(m => `${m.role}: ${m.content}`).join('\n\n') + `\n\nuser: ${prompt}`
      : prompt

    // ── Phase 1: Sonnet — gathers info with tools, produces the draft plan ─────
    const response = query({
      prompt: fullPrompt,
      options: {
        allowedTools: ALLOWED_TOOLS,
        customSystemPrompt: systemPrompt,
        maxTurns: overrides?.maxTurns ?? 20,
        ...(overrides?.allowedTools !== undefined && { allowedTools: overrides.allowedTools }),
        ...(overrides?.model && { model: overrides.model }),
      },
    })

    for await (const msg of response) {
      if (msg.type === 'assistant') {
        const assistantMsg = msg as SDKAssistantMessage
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            totalText += block.text
            yield { type: 'text', content: block.text }
          } else if (block.type === 'tool_use') {
            const toolInput = JSON.stringify(block.input)
            toolsUsed.push(`${block.name}(${toolInput})`)
            toolCallLog.push({ tool: block.name, input: toolInput })
            yield { type: 'tool_call', tool: block.name, input: toolInput }
          }
        }
      } else if (msg.type === 'user') {
        const userMsg = msg as { type: 'user'; message: { role: 'user'; content: unknown[] } }
        for (const block of userMsg.message.content as Array<{ type: string; content?: unknown }>) {
          if (block.type === 'tool_result') {
            const result = Array.isArray(block.content)
              ? (block.content as Array<{ type: string; text?: string }>).map(c => c.type === 'text' ? c.text : '').join('')
              : String(block.content ?? '')
            if (toolCallLog.length > 0) toolCallLog[toolCallLog.length - 1].output = result
            yield { type: 'tool_result', output: result }
          }
        }
      } else if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage
        const subtype = (resultMsg as { subtype?: string }).subtype
        const resultText = subtype === 'success' ? (resultMsg as { result: string }).result : undefined
        process.stderr.write(`[claude] result: subtype=${subtype} result_len=${resultText?.length ?? 0}\n`)
        if (resultText && resultText.trim() && !totalText.includes(resultText.trim())) {
          totalText += (totalText ? '\n\n' : '') + resultText
          yield { type: 'text', content: resultText }
        }
      }
    }

    // ── Phase 2 (planning only): Opus reviews the Sonnet draft ────────────────
    let opusReview = ''
    if (planTarget && totalText.trim()) {
      const separator = '\n\n---\n\n*Reviewing with Opus...*\n\n'
      yield { type: 'text', content: separator }

      const opusReviewText = await collectQueryText(query({
        prompt: `Review this draft plan and output the final, improved version. Work only from the text below — do not attempt to run any commands or gather additional information. Fill gaps, sharpen implementation steps, remove vagueness, and ensure the plan is complete and actionable. Output the final plan directly with no preamble and no open-ended questions at the end.

Draft plan to review:

${totalText}`,
        options: {
          allowedTools: [],
          customSystemPrompt: 'You are a senior technical architect. Your only job is to review and refine the draft plan provided in the prompt. Do not run any tools or commands. Do not ask for more information. Output the final plan immediately.',
          maxTurns: 1,
          model: 'claude-opus-4-6',
        },
      }))

      if (opusReviewText) {
        opusReview = opusReviewText
        yield { type: 'text', content: opusReviewText }
      }
    }

    const fullContent = opusReview
      ? `${totalText}\n\n---\n\n*Reviewing with Opus...*\n\n${opusReview}`
      : totalText
    // Cap stored content to ~1000 tokens to prevent history bloat
    const MAX_STORE_CHARS = 4000
    const savedContent = fullContent.length > MAX_STORE_CHARS
      ? fullContent.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : fullContent

    // Save BEFORE yielding done — code after the last yield never runs because
    // the consumer breaks out of the for-await loop, calling iterator.return().
    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent, ...(toolCallLog.length > 0 && { metadata: { toolCalls: toolCallLog } }) } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed, durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed, durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: msg }
  }
}
