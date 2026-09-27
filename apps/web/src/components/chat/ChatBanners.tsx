'use client'
import { useState } from 'react'
import { Loader2, ClipboardCheck, Check, Bot } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import type { ChatMode } from './chat-types'

const bannerButton = 'flex items-center gap-1.5 px-3 py-1 rounded-sm text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent/15 text-accent hover:bg-accent/30'
const draftField = 'min-w-0 px-2 py-1 text-xs border-border-visible placeholder-text-muted'

export interface AgentDraftForm { name: string; role: string; type: string }

interface Props {
  mode: ChatMode
  hasAnswer: boolean
  streaming: boolean
  saved: boolean
  creatingAgent: boolean
  onSavePlan: () => void
  onSaveToAgent: () => void
  onCreateAgent: (form: AgentDraftForm) => void
}

/** Mode banner under the header (planning, agent draft, agent chat, agent planning). */
export function ChatBanners({ mode, hasAnswer, streaming, saved, creatingAgent, onSavePlan, onSaveToAgent, onCreateAgent }: Props) {
  switch (mode.kind) {
    case 'plan':
      return (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-accent/5 shrink-0">
          <span className="text-xs text-accent">Planning mode — linked to {mode.target.type}</span>
          <button onClick={onSavePlan} disabled={!hasAnswer || streaming} className={bannerButton}>
            {saved ? <><Check size={12} /> Saved!</> : <><ClipboardCheck size={12} /> Save plan to {mode.target.type}</>}
          </button>
        </div>
      )
    case 'agentDraft':
      return <AgentDraftBanner hasAnswer={hasAnswer} creating={creatingAgent} onCreate={onCreateAgent} />
    case 'agentChat':
      return (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-accent/5 shrink-0">
          <Bot size={13} className="text-accent shrink-0" />
          <span className="text-xs text-accent font-medium">Chatting with {mode.agent.name}</span>
        </div>
      )
    case 'agentTarget':
      return (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-accent/5 shrink-0">
          <div className="flex items-center gap-2">
            <Bot size={13} className="text-accent" />
            <span className="text-xs text-accent">Agent planning — {mode.agent.name}</span>
          </div>
          <button onClick={onSaveToAgent} disabled={!hasAnswer || streaming} className={bannerButton}>
            {saved ? <><Check size={12} /> Saved!</> : <><ClipboardCheck size={12} /> Save to agent</>}
          </button>
        </div>
      )
    default:
      return null
  }
}

function AgentDraftBanner({ hasAnswer, creating, onCreate }: { hasAnswer: boolean; creating: boolean; onCreate: (f: AgentDraftForm) => void }) {
  const [form, setForm] = useState<AgentDraftForm>({ name: '', role: '', type: 'claude' })
  return (
    <div className="border-b border-border-subtle bg-accent/5 shrink-0">
      <div className="flex items-center gap-2 px-4 py-2">
        <Bot size={13} className="text-accent shrink-0" />
        <span className="text-xs text-accent flex-1">Agent creation mode — chat with Claude to define your agent</span>
      </div>
      {hasAnswer && (
        <div className="flex items-center gap-2 px-4 pb-2.5">
          <Input
            aria-label="Agent name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Agent name *"
            className={`flex-1 ${draftField}`}
          />
          <Input
            aria-label="Agent role"
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            placeholder="Role (e.g. DevOps)"
            className={`flex-1 ${draftField}`}
          />
          <Select
            aria-label="Agent type"
            value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className={`w-auto ${draftField}`}
          >
            <option value="claude">Claude</option>
            <option value="human">Human</option>
            <option value="custom">Custom</option>
          </Select>
          <button
            onClick={() => onCreate(form)}
            disabled={!form.name.trim() || creating}
            className={`${bannerButton} whitespace-nowrap`}
          >
            {creating ? <><Loader2 size={11} className="animate-spin" /> Creating…</> : <><Check size={11} /> Create Agent</>}
          </button>
        </div>
      )}
    </div>
  )
}

/** Empty-conversation placeholder for the current mode. */
export function ChatEmptyState({ mode }: { mode: ChatMode }) {
  const botIcon = (
    <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4">
      <Bot size={22} className="text-accent" />
    </div>
  )
  return (
    <div className="flex flex-col items-center justify-center h-full text-center text-text-muted">
      {mode.kind === 'agentChat' ? (
        <>
          {botIcon}
          <p className="text-sm font-medium">{mode.agent.name}</p>
          <p className="text-xs mt-1 opacity-60">Send a message to start the conversation.</p>
        </>
      ) : mode.kind === 'agentDraft' ? (
        <>
          {botIcon}
          <p className="text-sm">Creating a new agent</p>
          <p className="text-xs mt-1 opacity-60">Describe what you need — Claude will help define the role, responsibilities, and system prompt.</p>
        </>
      ) : mode.kind === 'agentTarget' ? (
        <>
          {botIcon}
          <p className="text-sm">Planning agent: <span className="text-accent">{mode.agent.name}</span></p>
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
      )}
    </div>
  )
}
