import { NextRequest } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { streamClaudeResponse, streamAgentChat, streamOllamaChat, streamGeminiChat, streamOpenAIChat, type AgentContextConfig } from '@/lib/claude'
import { prisma } from '@/lib/db'
import { getPrompt } from '@/lib/system-prompts'
import { getToken } from 'next-auth/jwt'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { prompt: rawPrompt, ollamaModel: explicitOllamaModel, targetEnvironmentId } = await req.json()

  // Rewrite @mentions so the LLM sees the real environment ID, not just the name.
  // e.g. "@localhost" → "@localhost (environment_id: cmnv32drm0000libvj5vwm5pw)"
  let prompt: string = rawPrompt
  if (rawPrompt && rawPrompt.includes('@')) {
    const allEnvs = await prisma.environment.findMany({ select: { id: true, name: true } })
    prompt = rawPrompt.replace(/@([\w-]+)/g, (_match: string, name: string) => {
      const env = allEnvs.find((e: { id: string; name: string }) => e.name.toLowerCase() === name.toLowerCase())
      return env ? `@${env.name} (environment_id: ${env.id})` : `@${name}`
    })
  }
  const { id: conversationId } = params

  // Get the current user from session (used for permission checks in tool loop)
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  const userId = token?.sub as string | undefined

  // Verify conversation exists and get metadata
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } })
  if (!convo) {
    return new Response('Conversation not found', { status: 404 })
  }

  const meta = convo.metadata as Record<string, unknown> | null

  // Resolve effective model: explicit selection > planModel > system default > built-in Claude
  const planModel = meta?.planModel as string | undefined
  // claude / claude:* IDs → use Claude; everything else → try to route to Ollama/Gemini
  let rawModel = explicitOllamaModel ?? (planModel && !planModel.startsWith('claude') ? planModel : undefined)
  // If nothing selected, check system default
  if (!rawModel) {
    const defaultSetting = await prisma.systemSetting.findUnique({ where: { key: 'model.default' } })
    const def = defaultSetting?.value as string | undefined
    // Only use default if it's not a claude:* model (those are resolved below as Claude)
    if (def && !def.startsWith('claude:')) rawModel = def
  }
  // Route: gemini:* → Gemini; ext:* → look up from DB; ollama:* or bare name → Ollama
  // claude:* or no model → Claude (built-in)
  const geminiModel = rawModel?.startsWith('gemini:') ? rawModel.slice('gemini:'.length) : undefined
  let ollamaModel: string | undefined
  let ollamaBaseUrl: string | undefined
  let openaiModel: string | undefined
  let openaiBaseUrl: string | undefined
  let openaiApiKey: string | undefined
  if (!geminiModel && rawModel && !rawModel.startsWith('claude:')) {
    if (rawModel.startsWith('ext:')) {
      const extId = rawModel.slice('ext:'.length)
      const ext = await prisma.externalModel.findUnique({ where: { id: extId } })
      if (ext) {
        if (ext.provider === 'ollama') {
          ollamaModel   = ext.modelId
          ollamaBaseUrl = ext.baseUrl ?? undefined
        } else {
          // openai / custom — use OpenAI-compatible streaming
          openaiModel   = ext.modelId
          openaiBaseUrl = ext.baseUrl ?? undefined
          openaiApiKey  = ext.apiKey  ?? undefined
        }
      }
    } else {
      ollamaModel = rawModel.startsWith('ollama:') ? rawModel.slice('ollama:'.length) : rawModel
    }
  }
  const planTarget  = meta?.planTarget  as { type: string; id: string } | undefined
  const agentChat   = meta?.agentChat   as { id: string; name: string } | undefined
  const agentDraft  = meta?.agentDraft  as boolean | undefined

  // If this is an agent chat, load the agent's system prompt and context config
  let agentSystemPrompt: string | undefined
  let agentContextConfig: AgentContextConfig = {}
  if (agentChat?.id) {
    const agent = await prisma.agent.findUnique({ where: { id: agentChat.id } })
    if (agent) {
      const agentMeta = agent.metadata as Record<string, unknown> | null
      const customPrompt = agentMeta?.systemPrompt as string | undefined
      agentSystemPrompt = customPrompt
        ? `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}.\n\n${customPrompt}`
        : `You are ${agent.name}${agent.role ? `, a ${agent.role}` : ''}${agent.description ? `.\n\n${agent.description}` : '.'}`
      agentContextConfig = (agentMeta?.contextConfig as AgentContextConfig) ?? {}
    }
  }

  // History window: respect agent's contextConfig, increased defaults for better context retention
  // Regular chats: 30 messages (was 10), Agent chats: 12 messages (was 6)
  const historyLimit = agentSystemPrompt
    ? (agentContextConfig.historyMessages ?? 12)
    : 30
  const rawHistory = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },  // most recent first
    take: historyLimit,
    select: { role: true, content: true },
  })
  rawHistory.reverse()  // back to chronological order
  // Cap individual message size to prevent bloated history (tool output, API dumps, etc.)
  // Increased from 2000 to 5000 to preserve more context from tool outputs
  const MAX_MSG_CHARS = 5000
  const history = rawHistory.map(m => ({
    role: m.role,
    content: m.content.length > MAX_MSG_CHARS
      ? m.content.slice(0, MAX_MSG_CHARS) + '\n[…truncated]'
      : m.content,
  }))

  const abortCtrl = new AbortController()

  return createSSEStream((send, close) => {
    ;(async () => {
      const agentCreationPrompt = agentDraft && !agentSystemPrompt
        ? await getPrompt('system.agent-creation')
        : undefined

      const generator = agentSystemPrompt
        ? streamAgentChat(prompt, conversationId, agentSystemPrompt, history, agentContextConfig, agentChat?.id, userId, targetEnvironmentId)
        : openaiModel && openaiBaseUrl
        ? streamOpenAIChat(prompt, conversationId, history, openaiModel, openaiBaseUrl, openaiApiKey, abortCtrl.signal, userId, targetEnvironmentId)
        : ollamaModel
        ? streamOllamaChat(prompt, conversationId, history, ollamaModel, ollamaBaseUrl, abortCtrl.signal, userId, targetEnvironmentId)
        : geminiModel
        ? streamGeminiChat(prompt, conversationId, history, geminiModel, abortCtrl.signal)
        : streamClaudeResponse(prompt, conversationId, history, planTarget, agentCreationPrompt, undefined, abortCtrl.signal)
      for await (const chunk of generator) {
        send(chunk.type, chunk)
        if (chunk.type === 'done' || chunk.type === 'error') {
          close()
          break
        }
      }
    })()

    // Called when the client disconnects or aborts — cancels the in-flight Ollama request
    return () => abortCtrl.abort()
  })
}
