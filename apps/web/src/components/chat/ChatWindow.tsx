'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Loader2 } from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { useChatStream } from './useChatStream'
import { ChatHeader } from './ChatHeader'
import { ChatBanners, ChatEmptyState, type AgentDraftForm } from './ChatBanners'
import { ChatComposer } from './ChatComposer'
import {
  modeFromMetadata, PROVIDER_CONFIG,
  type AppModel, type ChatEnvironment, type ChatMode, type Conversation, type ConversationMetadata, type ToolCall,
} from './chat-types'

interface Props {
  conversationId: string | null
  onConversationCreated: (convo: Conversation) => void
  onMobileBack?: () => void
}

type StoredMessage = { role: string; content: string; metadata?: { toolCalls?: ToolCall[] } }

const PLAIN: ChatMode = { kind: 'plain' }
const NO_MODELS: AppModel[] = []

export function ChatWindow({ conversationId, onConversationCreated, onMobileBack }: Props) {
  const router = useRouter()
  const toast = useToast()
  const { messages, setMessages, streaming, send, stop, abandon } = useChatStream()
  const [mode, setMode] = useState<ChatMode>(PLAIN)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)

  // Selected non-Claude model id; null = Claude. Mirrored in a ref for async code.
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  const ollamaModelRef = useRef<string | null>(null)
  const setModel = useCallback((id: string | null) => { setOllamaModel(id); ollamaModelRef.current = id }, [])

  const { data: availableModels = NO_MODELS } = useSWR<AppModel[]>('/api/models', { revalidateOnFocus: false })
  const { data: allEnvironments } = useSWR<ChatEnvironment[]>('/api/environments', { revalidateOnFocus: false })
  const environments = (allEnvironments ?? []).filter(e => e.status === 'connected')

  // Apply the default model once, if nothing was explicitly chosen.
  const defaultAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultAppliedRef.current || availableModels.length === 0) return
    defaultAppliedRef.current = true
    if (ollamaModelRef.current !== null) return
    const def = availableModels.find(m => m.isDefault)
    if (def) setModel(def.provider === 'anthropic' ? null : def.id)
  }, [availableModels, setModel])

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const skipNextFetchRef = useRef(false)
  const autoSendRef = useRef<string | null>(null)

  // Load conversation metadata + messages when conversationId changes
  useEffect(() => {
    const justCreated = skipNextFetchRef.current
    // A stream started in another conversation must not keep writing into this
    // one. The exception is the conversation we just created from send().
    if (!justCreated) abandon()
    if (!conversationId) {
      setMessages([])
      setMode(PLAIN)
      setModel(null)
      setLoadError(null)
      return
    }
    if (justCreated) {
      skipNextFetchRef.current = false
      return
    }
    let cancelled = false
    nearBottomRef.current = true
    setLoading(true)
    setLoadError(null)
    Promise.all([
      apiFetch<{ metadata?: ConversationMetadata }>(`/api/chat/conversations/${conversationId}`, { cache: 'no-store' }).catch(() => null),
      apiFetch<StoredMessage[]>(`/api/chat/conversations/${conversationId}/messages`, { cache: 'no-store' }),
    ])
      .then(([convo, msgs]) => {
        if (cancelled) return
        const mapped = msgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, toolCalls: m.metadata?.toolCalls }))
        setMessages(mapped)
        if (mapped.length === 0 && convo?.metadata?.initialContext) autoSendRef.current = convo.metadata.initialContext
        setModel(convo?.metadata?.ollamaModel ?? null)
        setMode(modeFromMetadata(convo?.metadata))
      })
      .catch(err => { if (!cancelled) setLoadError(errorMessage(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [conversationId, abandon, setMessages, setModel])

  // Follow new content only while the user is already near the bottom, and at
  // most once per animation frame (streaming updates arrive per token).
  useEffect(() => {
    if (!nearBottomRef.current || scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth', block: 'end' })
    })
  }, [messages, streaming])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  const resolveConversationId = async (): Promise<string> => {
    if (conversationId) return conversationId
    const c = await apiFetch<Conversation>('/api/chat/conversations', { method: 'POST', body: {} })
    skipNextFetchRef.current = true
    onConversationCreated(c)
    return c.id
  }

  const sendPrompt = (prompt: string, targetEnvironmentId?: string) => {
    nearBottomRef.current = true
    void send({
      prompt,
      conversationId: resolveConversationId,
      body: {
        ...(ollamaModelRef.current && mode.kind !== 'agentChat' ? { ollamaModel: ollamaModelRef.current } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      },
    })
  }

  // Fire auto-send once loading is done and there's a pending initialContext
  useEffect(() => {
    if (!loading && autoSendRef.current) {
      const prompt = autoSendRef.current
      autoSendRef.current = null
      sendPrompt(prompt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a load finishes
  }, [loading])

  // ── Mode actions ─────────────────────────────────────────────────────────────

  const lastAnswer = () => [...messages].reverse().find(m => m.role === 'assistant')

  const savePlan = async () => {
    if (mode.kind !== 'plan') return
    const answer = lastAnswer()
    if (!answer) return
    const { type, id } = mode.target
    try {
      await apiFetch(`/api/${type === 'epic' ? 'epics' : type === 'feature' ? 'features' : 'tasks'}/${id}`, {
        method: 'PUT', body: { plan: answer.content },
      })
    } catch (e) {
      toast.error(`Failed to save plan: ${errorMessage(e)}`)
      return
    }
    setSaved(true)
    router.push(type === 'epic' ? `/tasks?epicId=${id}` : type === 'feature' ? `/tasks?featureId=${id}` : `/tasks?taskId=${id}`)
  }

  const createAgent = async (form: AgentDraftForm) => {
    if (!form.name.trim() || !conversationId) return
    setCreatingAgent(true)
    try {
      const answer = lastAnswer()?.content?.trim()
      const agent = await apiFetch<{ id: string; name: string }>('/api/agents', {
        method: 'POST',
        body: {
          name: form.name,
          type: form.type === 'custom' ? 'claude' : form.type,
          role: form.role || null,
          metadata: answer ? { systemPrompt: answer } : undefined,
        },
      })
      // Link this conversation to the new agent
      await apiFetch(`/api/chat/conversations/${conversationId}`, {
        method: 'PATCH', body: { metadata: { agentTarget: { id: agent.id, name: agent.name } } },
      })
      router.push('/agents')
    } catch (err) {
      toast.error(`Failed to create agent: ${errorMessage(err, 'Unknown error')}`)
      setCreatingAgent(false)
    }
  }

  const saveToAgent = async () => {
    if (mode.kind !== 'agentTarget') return
    const answer = lastAnswer()
    if (!answer) return
    try {
      await apiFetch(`/api/agents/${mode.agent.id}`, { method: 'PUT', body: { metadata: { systemPrompt: answer.content } } })
    } catch (e) {
      toast.error(`Failed to save to agent: ${errorMessage(e)}`)
      return
    }
    setSaved(true)
    setTimeout(() => router.push('/agents'), 800)
  }

  const switchModel = (model: string | null) => {
    setModel(model)
    if (conversationId) {
      apiFetch(`/api/chat/conversations/${conversationId}`, {
        method: 'PATCH', body: { metadata: { ollamaModel: model ?? undefined } },
      }).catch(() => { /* preference only; the next send still uses the chosen model */ })
    }
  }

  // Resolve which provider/model is active
  const currentProvider = ollamaModel === null
    ? 'anthropic'
    : availableModels.find(m => m.provider === 'ollama' && m.modelId === ollamaModel)?.provider
      ?? availableModels.find(m => m.id === ollamaModel)?.provider
      ?? 'anthropic'
  const selectedModelId = currentProvider === 'anthropic'
    ? 'claude'
    : (availableModels.find(m => m.id === ollamaModel)?.id ?? availableModels.find(m => m.provider === currentProvider)?.id ?? '')

  const placeholder =
    mode.kind === 'agentChat'   ? `Message ${mode.agent.name}...` :
    mode.kind === 'agentTarget' ? `Describe what ${mode.agent.name} should do...` :
    currentProvider !== 'anthropic' ? `Ask ${PROVIDER_CONFIG[currentProvider]?.label ?? currentProvider}... (Enter to send)` :
    'Ask Claude about your cluster... Type @ to target an environment'

  const hasAnswer = messages.some(m => m.role === 'assistant')

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      <ChatHeader
        mode={mode}
        conversationId={conversationId}
        models={availableModels}
        currentProvider={currentProvider}
        selectedModelId={selectedModelId}
        onMobileBack={onMobileBack}
        onOpenTraces={() => router.push(`/conversations/${conversationId}/traces`)}
        onSwitchModel={switchModel}
      />
      <ChatBanners
        key={conversationId ?? 'new'}
        mode={mode}
        hasAnswer={hasAnswer}
        streaming={streaming}
        saved={saved}
        creatingAgent={creatingAgent}
        onSavePlan={() => void savePlan()}
        onSaveToAgent={() => void saveToAgent()}
        onCreateAgent={form => void createAgent(form)}
      />

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-busy={streaming} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="flex items-center justify-center h-full text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}
        {!loading && loadError && (
          <div role="alert" className="flex items-center justify-center h-full text-red-400 text-sm">
            Failed to load messages: {loadError}
          </div>
        )}
        {!loading && !loadError && messages.length === 0 && <ChatEmptyState mode={mode} />}
        {!loading && !loadError && messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      <ChatComposer
        conversationId={conversationId}
        environments={environments}
        placeholder={placeholder}
        streaming={streaming}
        onSend={sendPrompt}
        onStop={stop}
      />
    </div>
  )
}
