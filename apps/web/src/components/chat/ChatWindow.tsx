'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send, Loader2, ClipboardCheck, Check, ChevronLeft, Bot, Square } from 'lucide-react'

const PROVIDER_CONFIG: Record<string, { label: string; activeClass: string; modelClass: string }> = {
  anthropic: { label: 'Claude',  activeClass: 'bg-blue-500/20 text-blue-400 border-blue-500/40',     modelClass: 'bg-blue-500/10 text-blue-300 border-blue-500/30' },
  ollama:    { label: 'Ollama',  activeClass: 'bg-orange-500/20 text-orange-400 border-orange-500/40', modelClass: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
  google:    { label: 'Gemini',  activeClass: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',       modelClass: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
  openai:    { label: 'OpenAI',  activeClass: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', modelClass: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  custom:    { label: 'Custom',  activeClass: 'bg-purple-500/20 text-purple-400 border-purple-500/40', modelClass: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
}
const PROVIDER_ORDER = ['anthropic', 'google', 'ollama', 'openai', 'custom']
import { MessageBubble } from './MessageBubble'
import type { StreamChunk } from '@/lib/claude'

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ tool: string; input: string; output?: string }>
  streaming?: boolean
}

interface AppModel { id: string; name: string; provider: string; builtIn: boolean; modelId: string }

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
}

interface PlanTarget { type: 'task' | 'feature' | 'epic'; id: string }
interface AgentTarget { id: string; name: string }
interface AgentChat   { id: string; name: string }
interface AgentDraftForm { name: string; role: string; type: string }

interface Props {
  conversationId: string | null
  onConversationCreated: (convo: Conversation) => void
  onMobileBack?: () => void
}

export function ChatWindow({ conversationId, onConversationCreated, onMobileBack }: Props) {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [planTarget, setPlanTarget] = useState<PlanTarget | null>(null)
  const [agentTarget, setAgentTarget] = useState<AgentTarget | null>(null)
  const [agentChat,   setAgentChat]   = useState<AgentChat | null>(null)
  const [agentDraft, setAgentDraft] = useState(false)
  const [draftForm, setDraftForm] = useState<AgentDraftForm>({ name: '', role: '', type: 'claude' })
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  const ollamaModelRef = useRef<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AppModel[]>([])
  useEffect(() => { fetch('/api/models').then(r => r.json()).then(setAvailableModels).catch(() => {}) }, [])

  // Resolve which provider/model is active
  const currentProvider = ollamaModel === null
    ? 'anthropic'
    : availableModels.find(m => m.provider === 'ollama' && m.modelId === ollamaModel)?.provider
      ?? availableModels.find(m => m.id === ollamaModel)?.provider
      ?? 'anthropic'
  const uniqueProviders = PROVIDER_ORDER.filter(p => availableModels.some(m => m.provider === p))
  const currentProviderModels = availableModels.filter(m => m.provider === currentProvider)
  // Resolve which model within the current provider is selected
  const selectedModelId = currentProvider === 'anthropic'
    ? 'claude'
    : currentProvider === 'ollama'
      ? (availableModels.find(m => m.provider === 'ollama' && m.modelId === ollamaModel)?.id ?? currentProviderModels[0]?.id ?? '')
      : (availableModels.find(m => m.id === ollamaModel)?.id ?? currentProviderModels[0]?.id ?? '')
  const [streaming, setStreaming] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const skipNextFetchRef = useRef(false)
  const autoSendRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [saved, setSaved] = useState(false)

  // Load conversation metadata + messages when conversationId changes
  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setInput('')
      setPlanTarget(null)
      setAgentTarget(null)
      setAgentChat(null)
      setAgentDraft(false)
      setOllamaModel(null)
      setLoadError(null)
      return
    }
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false
      return
    }
    setLoading(true)
    setLoadError(null)
    Promise.all([
      fetch(`/api/chat/conversations/${conversationId}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/chat/conversations/${conversationId}/messages`, { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }),
    ])
      .then(([convo, msgs]: [{ metadata?: { initialContext?: string; planTarget?: PlanTarget; agentTarget?: AgentTarget; agentChat?: AgentChat; agentDraft?: boolean; ollamaModel?: string } } | null, Array<{ role: string; content: string; metadata?: { toolCalls?: Array<{ tool: string; input: string; output?: string }> } }>]) => {
        const mapped = msgs.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          toolCalls: m.metadata?.toolCalls,
        }))
        setMessages(mapped)
        if (mapped.length === 0 && convo?.metadata?.initialContext) {
          autoSendRef.current = convo.metadata.initialContext
        }
        const loadedModel = convo?.metadata?.ollamaModel ?? null
        setOllamaModel(loadedModel)
        ollamaModelRef.current = loadedModel
        if (convo?.metadata?.planTarget) {
          setPlanTarget(convo.metadata.planTarget)
          setAgentTarget(null)
          setAgentChat(null)
          setAgentDraft(false)
        } else if (convo?.metadata?.agentChat) {
          setAgentChat(convo.metadata.agentChat)
          setPlanTarget(null)
          setAgentTarget(null)
          setAgentDraft(false)
        } else if (convo?.metadata?.agentTarget) {
          setAgentTarget(convo.metadata.agentTarget)
          setPlanTarget(null)
          setAgentChat(null)
          setAgentDraft(false)
        } else if (convo?.metadata?.agentDraft) {
          setAgentDraft(true)
          setPlanTarget(null)
          setAgentTarget(null)
          setAgentChat(null)
        } else {
          setPlanTarget(null)
          setAgentTarget(null)
          setAgentChat(null)
          setAgentDraft(false)
        }
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fire auto-send once loading is done and there's a pending initialContext
  useEffect(() => {
    if (!loading && autoSendRef.current) {
      const prompt = autoSendRef.current
      autoSendRef.current = null
      send(prompt)
    }
  }, [loading])

  const createConversation = async () => {
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const c: Conversation = await r.json()
    skipNextFetchRef.current = true
    onConversationCreated(c)
    return c.id
  }

  const send = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? input).trim()
    if (!prompt || streaming) return

    if (!promptOverride) setInput('')
    setStreaming(true)

    const abort = new AbortController()
    abortRef.current = abort

    const userMsg: Message = { role: 'user', content: prompt }
    const assistantMsg: Message = { role: 'assistant', content: '', toolCalls: [], streaming: true }
    setMessages(prev => [...prev, userMsg, assistantMsg])

    try {
      const convId = conversationId ?? await createConversation()

      const resp = await fetch(`/api/chat/conversations/${convId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...(ollamaModelRef.current && !agentChat ? { ollamaModel: ollamaModelRef.current } : {}) }),
        signal: abort.signal,
      })

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n\n')
        buffer = lines.pop() ?? ''

        for (const block of lines) {
          const eventLine = block.split('\n').find(l => l.startsWith('event:'))
          const dataLine  = block.split('\n').find(l => l.startsWith('data:'))
          if (!eventLine || !dataLine) continue

          const event = eventLine.replace('event: ', '').trim() as StreamChunk['type']
          const data: StreamChunk = JSON.parse(dataLine.replace('data: ', ''))

          setMessages(prev => {
            const msgs = [...prev]
            const last = msgs[msgs.length - 1]
            if (!last || last.role !== 'assistant') return prev

            if (event === 'text' && data.content) {
              last.content += data.content
            } else if (event === 'tool_call') {
              last.toolCalls = [...(last.toolCalls ?? []), { tool: data.tool!, input: data.input! }]
            } else if (event === 'tool_result') {
              const tc = last.toolCalls?.[last.toolCalls.length - 1]
              if (tc) tc.output = data.output
            } else if (event === 'done' || event === 'error') {
              last.streaming = false
              if (event === 'error') {
                const raw = data.error ?? ''
                const msg = raw.includes('authentication_error') || raw.includes('Invalid API key') || raw.includes('401')
                  ? 'Authentication error — credentials need to be refreshed. Please contact your admin.'
                  : raw.includes('exited with code')
                  ? raw.replace(/^.*?(Invalid .+?)\s*·.*$/, '$1').trim() || 'Claude process failed — please try again.'
                  : raw
                last.content += `\n\n⚠ ${msg}`
              }
            }
            return msgs
          })
        }
      }
    } catch (err) {
      // Ignore abort errors — user cancelled intentionally
      if (err instanceof Error && err.name === 'AbortError') {
        // leave the partial response as-is
      } else {
        setMessages(prev => {
          const msgs = [...prev]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') {
            last.streaming = false
            last.content += `\n\n⚠ Error: ${err instanceof Error ? err.message : String(err)}`
          }
          return msgs
        })
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      setMessages(prev => {
        const msgs = [...prev]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') last.streaming = false
        return msgs
      })
    }
  }

  const savePlan = async () => {
    if (!planTarget) return
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return
    const urlMap: Record<string, string> = {
      task:    `/api/tasks/${planTarget.id}`,
      epic:    `/api/epics/${planTarget.id}`,
      feature: `/api/features/${planTarget.id}`,
    }
    await fetch(urlMap[planTarget.type], {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: lastAssistant.content }),
    })
    setSaved(true)
    const dest =
      planTarget.type === 'epic'    ? `/tasks?epicId=${planTarget.id}` :
      planTarget.type === 'feature' ? `/tasks?featureId=${planTarget.id}` :
                                      `/tasks?taskId=${planTarget.id}`
    router.push(dest)
  }

  const createAgent = async () => {
    if (!draftForm.name.trim() || !conversationId) return
    setCreatingAgent(true)
    try {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      const agentRes = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draftForm.name,
          type: draftForm.type,
          role: draftForm.role || null,
          metadata: lastAssistant?.content ? { systemPrompt: lastAssistant.content } : undefined,
        }),
      })
      const agent = await agentRes.json()
      // Link this conversation to the new agent
      await fetch(`/api/chat/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { agentTarget: { id: agent.id, name: agent.name } } }),
      })
      router.push('/agents')
    } finally {
      setCreatingAgent(false)
    }
  }

  const saveToAgent = async () => {
    if (!agentTarget) return
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return
    await fetch(`/api/agents/${agentTarget.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { systemPrompt: lastAssistant.content } }),
    })
    setSaved(true)
    setTimeout(() => {
      router.push('/agents')
    }, 800)
  }

  const switchModel = async (model: string | null) => {
    setOllamaModel(model)
    ollamaModelRef.current = model
    if (conversationId) {
      await fetch(`/api/chat/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { ollamaModel: model ?? undefined } }),
      }).catch(() => {})
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Title header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-sidebar flex-shrink-0">
        <div className="flex items-center gap-2">
          {onMobileBack && (
            <button onClick={onMobileBack} className="md:hidden flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mr-1">
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="text-xs font-medium text-text-primary">
            {agentChat ? agentChat.name : agentTarget ? `Agent: ${agentTarget.name}` : planTarget ? `Planning: ${planTarget.type}` : 'AI Chat'}
          </span>
        </div>
        {!agentChat && !agentTarget && !planTarget && availableModels.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            {/* Provider buttons */}
            <div className="flex items-center gap-1">
              {uniqueProviders.map(provider => {
                const cfg = PROVIDER_CONFIG[provider]
                const isActive = currentProvider === provider
                return (
                  <button
                    key={provider}
                    onClick={() => {
                      if (provider === currentProvider) return
                      if (provider === 'anthropic') {
                        switchModel(null)
                      } else {
                        const first = availableModels.find(m => m.provider === provider)
                        if (first) switchModel(first.provider === 'ollama' ? first.modelId : first.id)
                      }
                    }}
                    className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                      isActive ? cfg.activeClass : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {cfg?.label ?? provider}
                  </button>
                )
              })}
            </div>
            {/* Model picker — shown when the active provider has selectable models */}
            {currentProvider !== 'anthropic' && currentProviderModels.length > 0 && (
              <div className="flex items-center gap-1">
                {currentProviderModels.map(m => {
                  const isSelected = m.id === selectedModelId
                  const cfg = PROVIDER_CONFIG[currentProvider]
                  return (
                    <button
                      key={m.id}
                      onClick={() => switchModel(m.provider === 'ollama' ? m.modelId : m.id)}
                      className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                        isSelected
                          ? cfg.modelClass
                          : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {m.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Task planning banner */}
      {planTarget && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-accent/5 flex-shrink-0">
          <span className="text-xs text-accent">Planning mode — linked to {planTarget.type}</span>
          <button
            onClick={savePlan}
            disabled={!messages.some(m => m.role === 'assistant') || streaming}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent/15 text-accent hover:bg-accent/30"
          >
            {saved ? <><Check size={12} /> Saved!</> : <><ClipboardCheck size={12} /> Save plan to {planTarget.type}</>}
          </button>
        </div>
      )}
      {/* Agent draft banner — shown while planning a new agent */}
      {agentDraft && (
        <div className="border-b border-border-subtle bg-accent/5 flex-shrink-0">
          <div className="flex items-center gap-2 px-4 py-2">
            <Bot size={13} className="text-accent flex-shrink-0" />
            <span className="text-xs text-accent flex-1">Agent creation mode — chat with Claude to define your agent</span>
          </div>
          {messages.some(m => m.role === 'assistant') && (
            <div className="flex items-center gap-2 px-4 pb-2.5">
              <input
                value={draftForm.name}
                onChange={e => setDraftForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Agent name *"
                className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              />
              <input
                value={draftForm.role}
                onChange={e => setDraftForm(f => ({ ...f, role: e.target.value }))}
                placeholder="Role (e.g. DevOps)"
                className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              />
              <select
                value={draftForm.type}
                onChange={e => setDraftForm(f => ({ ...f, type: e.target.value }))}
                className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="claude">Claude</option>
                <option value="human">Human</option>
                <option value="custom">Custom</option>
              </select>
              <button
                onClick={createAgent}
                disabled={!draftForm.name.trim() || creatingAgent}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-accent/15 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {creatingAgent ? <><Loader2 size={11} className="animate-spin" /> Creating…</> : <><Check size={11} /> Create Agent</>}
              </button>
            </div>
          )}
        </div>
      )}
      {/* Agent chat banner */}
      {agentChat && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-accent/5 flex-shrink-0">
          <Bot size={13} className="text-accent flex-shrink-0" />
          <span className="text-xs text-accent font-medium">Chatting with {agentChat.name}</span>
        </div>
      )}
      {/* Agent planning banner */}
      {agentTarget && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-accent/5 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Bot size={13} className="text-accent" />
            <span className="text-xs text-accent">Agent planning — {agentTarget.name}</span>
          </div>
          <button
            onClick={saveToAgent}
            disabled={!messages.some(m => m.role === 'assistant') || streaming}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent/15 text-accent hover:bg-accent/30"
          >
            {saved ? <><Check size={12} /> Saved!</> : <><ClipboardCheck size={12} /> Save to agent</>}
          </button>
        </div>
      )}
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="flex items-center justify-center h-full text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}
        {!loading && loadError && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm">
            Failed to load messages: {loadError}
          </div>
        )}
        {!loading && !loadError && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted">
            {agentChat ? (
              <>
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4">
                  <Bot size={22} className="text-accent" />
                </div>
                <p className="text-sm font-medium">{agentChat.name}</p>
                <p className="text-xs mt-1 opacity-60">Send a message to start the conversation.</p>
              </>
            ) : agentDraft ? (
              <>
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4">
                  <Bot size={22} className="text-accent" />
                </div>
                <p className="text-sm">Creating a new agent</p>
                <p className="text-xs mt-1 opacity-60">Describe what you need — Claude will help define the role, responsibilities, and system prompt.</p>
              </>
            ) : agentTarget ? (
              <>
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4">
                  <Bot size={22} className="text-accent" />
                </div>
                <p className="text-sm">Planning agent: <span className="text-accent">{agentTarget.name}</span></p>
                <p className="text-xs mt-1 opacity-60">Describe what this agent should do, its responsibilities, and how it should behave.</p>
              </>
            ) : (
              <>
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4">
                  <span className="text-accent font-bold">AI</span>
                </div>
                <p className="text-sm">Ask anything about your cluster.</p>
                <p className="text-xs mt-1 opacity-60">Claude can run kubectl get, describe, and logs.</p>
              </>
            )
          }
          </div>
        )}
        {!loading && !loadError && messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border-subtle p-4">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={agentChat ? `Message ${agentChat.name}...` : agentTarget ? `Describe what ${agentTarget.name} should do...` : currentProvider !== 'anthropic' ? `Ask ${PROVIDER_CONFIG[currentProvider]?.label ?? currentProvider}... (Enter to send)` : 'Ask Claude about your cluster... (Enter to send, Shift+Enter for newline)'}
            rows={2}
            className="flex-1 resize-none rounded-lg border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted text-sm px-3 py-2 focus:outline-none focus:border-accent"
          />
          {streaming ? (
            <button
              onClick={() => abortRef.current?.abort()}
              title="Stop generation"
              className="p-2.5 rounded-lg bg-status-error/15 text-status-error hover:bg-status-error/30 transition-colors flex-shrink-0"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              onClick={() => send()}
              disabled={!input.trim()}
              className="p-2.5 rounded-lg bg-accent text-white hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
