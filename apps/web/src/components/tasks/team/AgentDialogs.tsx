'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Trash2, Bot, MessageSquare, MessageSquarePlus, Send, Square, Loader2, Check } from 'lucide-react'
import type { Agent } from '@/types/tasks'
import { Dialog } from '@/components/ui/Dialog'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useChatStream } from '@/components/chat/useChatStream'
import { AgentFormFields } from './AgentFormFields'
import { TokenUsageSection } from './TokenUsageSection'
import { agentColor, agentInitials, emptyForm, formFromAgent, type AgentForm, type ModelOption } from './agent-form'

const portal = (node: React.ReactNode) => createPortal(node, document.body)

// ── Create ───────────────────────────────────────────────────────────────────

interface CreateProps {
  models: ModelOption[]
  saving: boolean
  onClose: () => void
  onCreate: (form: AgentForm) => void
  onPlanWithAI: () => void
}

export function CreateAgentDialog({ models, saving, onClose, onCreate, onPlanWithAI }: CreateProps) {
  const [form, setForm] = useState<AgentForm>(emptyForm)
  const submit = () => { if (form.name.trim() && !saving) onCreate(form) }
  return portal(
    <Dialog onClose={onClose} labelledBy="new-agent-title" className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <h2 id="new-agent-title" className="text-sm font-semibold text-text-primary">New Agent</h2>
        <IconButton label="Close" onClick={onClose} className="p-1.5"><X size={14} /></IconButton>
      </div>
      <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
        <AgentFormFields form={form} onChange={setForm} models={models} autoFocus onSubmitKey={submit} />
      </div>
      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
        <Button variant="secondary" onClick={onClose} className="font-normal text-text-muted hover:text-text-primary hover:border-border-subtle">Cancel</Button>
        <Button variant="ghost" onClick={onPlanWithAI} className="font-normal bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent">
          <MessageSquarePlus size={11} /> Plan with AI
        </Button>
        <Button onClick={submit} disabled={!form.name.trim() || saving} className="px-4 font-normal">
          {saving ? 'Adding…' : 'Add Agent'}
        </Button>
      </div>
    </Dialog>
  )
}

// ── Edit ─────────────────────────────────────────────────────────────────────

interface EditProps {
  agent: Agent
  colorIndex: number
  models: ModelOption[]
  saving: boolean
  onClose: () => void
  onSave: (form: AgentForm) => void
  onDelete: () => void
  onChat: () => void
  onPlan: () => void
}

export function EditAgentDialog({ agent, colorIndex, models, saving, onClose, onSave, onDelete, onChat, onPlan }: EditProps) {
  const [form, setForm] = useState<AgentForm>(() => formFromAgent(agent))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = form.name || agent.name

  return portal(
    <Dialog onClose={onClose} labelledBy="edit-agent-title" className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
        <div className={`w-9 h-9 rounded-full ${agentColor(colorIndex)} flex items-center justify-center shrink-0`} aria-hidden>
          <span className="text-xs font-bold text-white">{agentInitials(title)}</span>
        </div>
        <div className="flex-1 min-w-0">
          <h2 id="edit-agent-title" className="text-sm font-semibold text-text-primary truncate">{title}</h2>
          {form.role && <p className="text-xs text-accent truncate">{form.role}</p>}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Chat with agent" onClick={onChat} className="p-1.5 hover:text-accent hover:bg-bg-raised"><MessageSquare size={14} /></IconButton>
          <IconButton label="Plan with Claude" onClick={onPlan} className="p-1.5 hover:text-accent hover:bg-bg-raised"><MessageSquarePlus size={14} /></IconButton>
          <IconButton label="Close" onClick={onClose} className="p-1.5"><X size={14} /></IconButton>
        </div>
      </div>

      <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
        <AgentFormFields form={form} onChange={setForm} models={models} showWatcher />
        <TokenUsageSection agentId={agent.id} />
      </div>

      <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
        <button
          onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          className={`px-3 py-1.5 text-xs rounded border transition-colors ${
            confirmDelete
              ? 'border-status-error bg-status-error/10 text-status-error'
              : 'border-border-subtle text-text-muted hover:border-status-error hover:text-status-error'
          }`}>
          <Trash2 size={12} className="inline mr-1" aria-hidden />
          {confirmDelete ? 'Confirm delete' : 'Delete'}
        </button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose} className="font-normal text-text-muted hover:text-text-primary hover:border-border-subtle">Cancel</Button>
        <Button onClick={() => onSave(form)} disabled={!form.name.trim() || saving} className="px-4 font-normal">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>
  )
}

// ── Plan with AI (agent creation chat) ───────────────────────────────────────

export interface AgentDraft { name: string; role: string; type: string }

interface PlanProps {
  conversationId: string
  initialPrompt: string
  creating: boolean
  onClose: () => void
  onCreate: (draft: AgentDraft, systemPrompt: string | undefined) => void
}

const draftField = 'min-w-0 px-2 py-1 text-xs border-border-visible placeholder-text-muted'

export function PlanAgentDialog({ conversationId, initialPrompt, creating, onClose, onCreate }: PlanProps) {
  const { messages, streaming, send, stop } = useChatStream()
  const [input, setInput] = useState('')
  const [draft, setDraft] = useState<AgentDraft>({ name: '', role: '', type: 'claude' })
  const bottomRef = useRef<HTMLDivElement>(null)
  const sentInitial = useRef(false)

  const sendPrompt = (prompt: string) => { void send({ prompt, conversationId: async () => conversationId }) }

  // Auto-send the planning instructions once, so Claude opens the conversation.
  useEffect(() => {
    if (sentInitial.current) return
    sentInitial.current = true
    sendPrompt(initialPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per dialog
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const submit = () => {
    const prompt = input.trim()
    if (!prompt || streaming) return
    setInput('')
    sendPrompt(prompt)
  }

  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant')?.content?.trim()

  return portal(
    <Dialog onClose={onClose} labelledBy="plan-agent-title" className="w-full max-w-2xl bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-modal-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-accent" />
          <h2 id="plan-agent-title" className="text-xs font-semibold text-text-primary">Plan with AI</h2>
        </div>
        <IconButton label="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>

      {/* Agent creation banner — shown after Claude responds */}
      {messages.some(m => m.role === 'assistant') && (
        <>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-accent/5 shrink-0">
            <Bot size={13} className="text-accent shrink-0" />
            <span className="text-xs text-accent flex-1">Agent creation mode — chat with Claude to define your agent</span>
          </div>
          <div className="flex items-center gap-2 px-4 pb-2.5 shrink-0">
            <Input aria-label="Agent name" value={draft.name} onChange={e => setDraft(f => ({ ...f, name: e.target.value }))}
              placeholder="Agent name *" className={`flex-1 ${draftField}`} />
            <Input aria-label="Agent role" value={draft.role} onChange={e => setDraft(f => ({ ...f, role: e.target.value }))}
              placeholder="Role (e.g. DevOps)" className={`flex-1 ${draftField}`} />
            <Select aria-label="Agent type" value={draft.type} onChange={e => setDraft(f => ({ ...f, type: e.target.value }))} className={`w-auto ${draftField}`}>
              <option value="claude">Claude</option>
              <option value="human">Human</option>
              <option value="custom">Custom</option>
            </Select>
            <button onClick={() => onCreate(draft, lastAnswer || undefined)} disabled={!draft.name.trim() || creating}
              className="flex items-center gap-1.5 px-3 py-1 rounded-sm text-xs font-medium bg-accent/15 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap">
              {creating ? <><Loader2 size={11} className="animate-spin" /> Creating…</> : <><Check size={11} /> Create Agent</>}
            </button>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4" role="log" aria-live="polite">
        {!messages.length ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted">
            <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4"><Bot size={22} className="text-accent" /></div>
            <p className="text-sm">Creating a new agent</p>
            <p className="text-xs mt-1 opacity-60">Describe what you need — Claude will help define the role, responsibilities, and system prompt.</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={msg.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap text-left ${
                msg.role === 'user' ? 'bg-accent/20 text-accent' : 'bg-bg-raised text-text-secondary border border-border-subtle'
              }`}>
                {msg.content || (msg.streaming ? <Loader2 size={12} className="animate-spin" aria-label="Thinking" /> : null)}
                {msg.toolCalls?.map((tc, j) => (
                  <div key={j} className="mt-1 text-[10px] text-text-muted">Tool: {tc.tool}</div>
                ))}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border-subtle p-3 shrink-0">
        <div className="flex gap-2">
          <Input aria-label="Message" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder={messages.length === 0 ? 'Describe what kind of agent you need…' : 'Type your message…'}
            disabled={streaming}
            className="flex-1 w-auto border-border-visible placeholder-text-muted" />
          {streaming ? (
            <IconButton label="Stop generation" onClick={stop} className="p-2.5 rounded-lg bg-status-error/15 text-status-error hover:text-status-error hover:bg-status-error/30"><Square size={16} /></IconButton>
          ) : (
            <IconButton label="Send message" onClick={submit} disabled={!input.trim()} className="p-2.5 rounded-lg bg-accent text-white hover:text-white hover:bg-accent/80 disabled:opacity-40"><Send size={16} /></IconButton>
          )}
        </div>
      </div>
    </Dialog>
  )
}
