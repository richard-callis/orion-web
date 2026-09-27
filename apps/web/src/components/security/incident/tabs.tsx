'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { CheckCircle, Clock, ExternalLink, Eye, FileText, Loader2, Plus, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { apiFetch, errorMessage } from '@/lib/api'
import { useInvestigation, useObservables } from './useInvestigation'
import { CardHeader, Empty, NoInvestigation, Spinner, card, severityText, verdictClass } from './shared'
import { OBSERVABLE_CATEGORIES, type ActionAudit, type ChatMessage, type IncidentEvent } from './types'

const TIER_BADGE: Record<string, string> = {
  auto: 'bg-blue-400/15 text-blue-400',
  approve: 'bg-orange-400/15 text-orange-400',
  escalate: 'bg-red-400/15 text-red-400',
}

export function EventsTab({ events }: { events: IncidentEvent[] }) {
  return (
    <div className={`${card} divide-y divide-border-subtle`}>
      {events.length === 0 ? (
        <Empty>No events linked to this incident.</Empty>
      ) : events.map(ev => (
        <Link key={ev.id} href={`/security/alerts/${ev.id}`} className="px-4 py-3 flex items-center gap-3 hover:bg-bg-raised transition-colors">
          <span className={`text-xs font-bold w-10 shrink-0 text-center ${severityText(ev.severity)}`} aria-label={`Severity ${ev.severity}`}>{ev.severity}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary">{ev.title}</div>
            <div className="text-xs text-text-muted">{ev.source} · {ev.type} · {new Date(ev.createdAt).toLocaleString()}</div>
          </div>
          <ExternalLink size={12} className="text-text-muted shrink-0" aria-hidden />
        </Link>
      ))}
    </div>
  )
}

function ActionStatusIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <CheckCircle size={14} className="text-status-healthy shrink-0" aria-label="Succeeded" />
  if (status === 'failed') return <XCircle size={14} className="text-status-error shrink-0" aria-label="Failed" />
  if (status === 'attempting') return <Loader2 size={14} className="text-blue-400 shrink-0 animate-spin" aria-label="In progress" />
  return <Clock size={14} className="text-status-warning shrink-0" aria-label="Pending" />
}

export function ActionsTab({ actions }: { actions: ActionAudit[] }) {
  return (
    <div className={`${card} divide-y divide-border-subtle`}>
      {actions.length === 0 ? (
        <Empty>No actions taken on this incident yet.</Empty>
      ) : actions.map(a => (
        <div key={a.id} className="px-4 py-3 flex items-center gap-3">
          <ActionStatusIcon status={a.status} />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary flex items-center gap-2">
              <code className="font-mono">{a.actionType}</code>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-sm ${TIER_BADGE[a.tier] ?? 'bg-bg-raised text-text-muted'}`}>{a.tier}</span>
            </div>
            <div className="text-xs text-text-muted">
              Target: {a.target} · by {a.proposedBy}
              {a.approvedBy && ` · approved by ${a.approvedBy}`}
            </div>
          </div>
          <span className="text-xs text-text-muted shrink-0">{new Date(a.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

export function ChatTab({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className={card}>
      <CardHeader>Warden Triage Log</CardHeader>
      {messages.length === 0 ? (
        <Empty>No chat messages for this incident.</Empty>
      ) : (
        <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto">
          {messages.map(msg => (
            <div key={msg.id} className="px-4 py-2.5 whitespace-pre-wrap text-sm text-text-secondary font-mono leading-relaxed">
              <span className="text-text-muted text-xs block mb-0.5">
                {msg.senderType === 'agent' ? 'Warden' : msg.senderType === 'system' ? 'System' : 'Unknown'}
                {' · '}
                {new Date(msg.createdAt).toLocaleString()}
              </span>
              {msg.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ObservablesTab({ investigationId }: { investigationId: string | null }) {
  const id = useId()
  const { observables, loading, reload } = useObservables(investigationId)
  const [category, setCategory] = useState<string>('ipv4')
  const [value, setValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!investigationId) return <div className={card}><NoInvestigation what="observables" /></div>

  const add = async () => {
    if (!value.trim()) return
    setAdding(true); setError(null)
    try {
      await apiFetch(`/api/monitoring/security/investigations/${investigationId}/observables`, {
        method: 'POST', body: { value: value.trim(), category },
      })
      setValue('')
      await reload()
    } catch (e) {
      setError(`Failed to add observable: ${errorMessage(e)}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className={`${card} p-4`}>
        <div className="flex items-center gap-2 mb-3">
          <Eye size={14} className="text-text-muted" aria-hidden />
          <span className="text-sm font-medium text-text-primary">Add Observable</span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-cat`} className="sr-only">Category</label>
          <Select id={`${id}-cat`} value={category} onChange={e => setCategory(e.target.value)} className="w-auto px-2 py-1.5 text-xs">
            {OBSERVABLE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
          <label htmlFor={`${id}-val`} className="sr-only">Value</label>
          <Input id={`${id}-val`} value={value} onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Value (e.g. 1.2.3.4, evil.com)" className="flex-1 px-3 py-1.5 text-xs font-mono" />
          <Button onClick={add} disabled={adding || !value.trim()} className="shrink-0">
            {adding ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Plus size={12} aria-hidden />}
            Add
          </Button>
        </div>
        {error && <p role="alert" className="text-xs text-status-error mt-2">{error}</p>}
      </div>

      <div className={card}>
        <CardHeader>Observables{observables ? ` (${observables.length})` : ''}</CardHeader>
        {loading ? <Spinner /> : !observables || observables.length === 0 ? (
          <Empty>No observables yet — add one above.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-subtle text-text-muted text-left">
                  {['Value', 'Category', 'Role', 'Verdict', 'Confidence', 'First Seen'].map(h => (
                    <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {observables.map(obs => (
                  <tr key={obs.id} className="hover:bg-bg-raised transition-colors">
                    <td className="px-4 py-2 font-mono text-text-primary truncate max-w-48">{obs.displayValue || obs.value}</td>
                    <td className="px-4 py-2 text-text-muted">{obs.category}</td>
                    <td className="px-4 py-2 text-text-muted">{obs.role}</td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${verdictClass(obs.verdict)}`}>{obs.verdict}</span>
                    </td>
                    <td className="px-4 py-2 text-text-muted">{obs.confidence}%</td>
                    <td className="px-4 py-2 text-text-muted">{new Date(obs.firstSeen).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export function NotesTab({ investigationId }: { investigationId: string | null }) {
  const id = useId()
  const { investigation, loading, reload } = useInvestigation(investigationId)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!investigationId) return <div className={card}><NoInvestigation /></div>

  const add = async () => {
    if (!content.trim()) return
    setSaving(true); setError(null)
    try {
      await apiFetch(`/api/monitoring/security/investigations/${investigationId}/notes`, { method: 'POST', body: { content } })
      setContent('')
      await reload()
    } catch (e) {
      setError(`Failed to save note: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className={`${card} p-4`}>
        <label htmlFor={`${id}-note`} className="flex items-center gap-2 mb-2">
          <FileText size={14} className="text-text-muted" aria-hidden />
          <span className="text-sm font-medium text-text-primary">Add Note</span>
        </label>
        <Textarea id={`${id}-note`} value={content} onChange={e => setContent(e.target.value)}
          placeholder="Add a note to the linked investigation..." rows={3} className="text-xs resize-none" />
        {error && <p role="alert" className="text-xs text-status-error mt-2">{error}</p>}
        <div className="flex justify-end mt-2">
          <Button onClick={add} disabled={saving || !content.trim()}>
            {saving ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Plus size={12} aria-hidden />}
            Add Note
          </Button>
        </div>
      </div>

      <div className={card}>
        <CardHeader>Notes{investigation ? ` (${investigation.notes.length})` : ''}</CardHeader>
        {loading ? <Spinner /> : !investigation || investigation.notes.length === 0 ? (
          <Empty>No notes yet</Empty>
        ) : (
          <div className="divide-y divide-border-subtle">
            {investigation.notes.map(note => (
              <div key={note.id} className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${note.authorType === 'warden' ? 'bg-purple-400/15 text-purple-400' : 'bg-accent/15 text-accent'}`}>
                    {note.authorType === 'warden' ? 'Warden' : note.author}
                  </span>
                  <span className="text-[10px] text-text-muted">{new Date(note.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-sm text-text-primary whitespace-pre-wrap mt-1">{note.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function TimelineTab({ investigationId }: { investigationId: string | null }) {
  const { investigation, loading } = useInvestigation(investigationId)
  return (
    <div className={card}>
      <CardHeader>Timeline{investigation ? ` (${investigation.timeline.length})` : ''}</CardHeader>
      {!investigationId ? <NoInvestigation /> : loading ? <Spinner /> : !investigation || investigation.timeline.length === 0 ? (
        <Empty>No timeline events</Empty>
      ) : (
        <ol className="divide-y divide-border-subtle">
          {investigation.timeline.map(entry => (
            <li key={entry.id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex flex-col items-center" aria-hidden>
                <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                <div className="w-px flex-1 bg-border-subtle mt-1" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{entry.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-raised text-text-muted">{entry.eventType}</span>
                  {entry.source && <span className="text-[10px] text-text-muted">via {entry.source}</span>}
                </div>
                {entry.description && <div className="text-xs text-text-muted mt-0.5">{entry.description}</div>}
                <div className="text-[10px] text-text-muted mt-0.5">{new Date(entry.eventTime).toLocaleString()}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
