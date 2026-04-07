import { NextRequest } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { streamClaudeResponse, streamAgentChat, streamOllamaChat, streamGeminiChat, type AgentContextConfig } from '@/lib/claude'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { prompt, ollamaModel: explicitOllamaModel } = await req.json()
  const { id: conversationId } = params

  // Verify conversation exists and get metadata
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } })
  if (!convo) {
    return new Response('Conversation not found', { status: 404 })
  }

  const meta = convo.metadata as Record<string, unknown> | null

  // Resolve effective model: explicit selection > planModel from conversation metadata > default (claude)
  const planModel = meta?.planModel as string | undefined
  // claude / claude:* IDs → use Claude; everything else → try to route to Ollama/Gemini
  const rawModel = explicitOllamaModel ?? (planModel && !planModel.startsWith('claude') ? planModel : undefined)
  // Route: gemini:* → Gemini; ext:* → look up from DB (Ollama); ollama:* or bare name → Ollama; else → claude
  const geminiModel = rawModel?.startsWith('gemini:') ? rawModel.slice('gemini:'.length) : undefined
  let ollamaModel: string | undefined
  let ollamaBaseUrl: string | undefined
  if (!geminiModel && rawModel) {
    if (rawModel.startsWith('ext:')) {
      const extId = rawModel.slice('ext:'.length)
      const ext = await prisma.externalModel.findUnique({ where: { id: extId } })
      if (ext && ext.provider === 'ollama') {
        ollamaModel  = ext.modelId
        ollamaBaseUrl = ext.baseUrl ?? undefined
      }
    } else {
      ollamaModel = rawModel.startsWith('ollama:') ? rawModel.slice('ollama:'.length) : rawModel
    }
  }
  const planTarget = meta?.planTarget as { type: string; id: string } | undefined
  const agentChat  = meta?.agentChat  as { id: string; name: string } | undefined

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

  // History window: respect agent's contextConfig, default 10 for regular chats, 6 for agent chats
  const historyLimit = agentSystemPrompt
    ? (agentContextConfig.historyMessages ?? 6)
    : 10
  const rawHistory = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },  // most recent first
    take: historyLimit,
    select: { role: true, content: true },
  })
  rawHistory.reverse()  // back to chronological order
  // Cap individual message size to prevent bloated history (tool output, API dumps, etc.)
  const MAX_MSG_CHARS = 2000
  const history = rawHistory.map(m => ({
    role: m.role,
    content: m.content.length > MAX_MSG_CHARS
      ? m.content.slice(0, MAX_MSG_CHARS) + '\n[…truncated]'
      : m.content,
  }))

  return createSSEStream((send, close) => {
    ;(async () => {
      const generator = agentSystemPrompt
        ? streamAgentChat(prompt, conversationId, agentSystemPrompt, history, agentContextConfig)
        : ollamaModel
        ? streamOllamaChat(prompt, conversationId, history, ollamaModel, ollamaBaseUrl)
        : geminiModel
        ? streamGeminiChat(prompt, conversationId, history, geminiModel)
        : streamClaudeResponse(prompt, conversationId, history, planTarget)
      for await (const chunk of generator) {
        send(chunk.type, chunk)
        if (chunk.type === 'done' || chunk.type === 'error') {
          close()
          break
        }
      }
    })()

    return () => {} // cleanup if client disconnects
  })
}
