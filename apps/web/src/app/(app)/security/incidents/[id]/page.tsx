'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Shield, Clock, CheckCircle, XCircle, MessageSquare, FileText, Loader2, Search, ExternalLink, Eye, Edit3, Plus, ChevronsUp } from 'lucide-react'
import Link from 'next/link'

interface ActionAudit {
  id: string
  actionType: string
  target: string
  tier: string
  status: string
  proposedBy: string
  approvedBy: string | null
  result: string | null
  payload: unknown
  createdAt: string
}

interface ChatMessage {
  id: string
  content: string
  createdAt: string
  senderType: string
}

interface Observable {
  id: string
  value: string
  displayValue: string | null
  category: string
  role: string
  verdict: string
  confidence: number
  firstSeen: string
}

interface Note {
  id: string
  content: string
  author: string
  authorType: string
  createdAt: string
}

interface TimelineEntry {
  id: string
  eventTime: string
  eventType: string
  title: string
  description: string | null
  source: string | null
}

interface Investigation {
  id: string
  observables: Observable[]
  notes: Note[]
  timeline: TimelineEntry[]
}

interface IncidentData {
  incident: {
    id: string
    status: string
    severity: number
    rootCauseSummary: string | null
    attackerKey: string | null
    hostKey: string | null
    openedAt: string
    closedAt: string | null
    investigationId: string | null
  }
  events: Array<{
    id: string
    type: string
    source: string
    severity: number
    title: string
    createdAt: string
    acknowledged: boolean
  }>
  actions: ActionAudit[]
  chatMessages: ChatMessage[]
}

const STATUS_FLOW = ['open', 'triaged', 'contained', 'closed'] as const

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<IncidentData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'events' | 'actions' | 'chat' | 'observables' | 'notes' | 'timeline'>('events')
  const [creatingInvestigation, setCreatingInvestigation] = useState(false)
  const [newStatus, setNewStatus] = useState('')
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const [loadingInvestigation, setLoadingInvestigation] = useState(false)
  const [noteContent, setNoteContent] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [observables, setObservables] = useState<Observable[] | null>(null)
  const [loadingObservables, setLoadingObservables] = useState(false)
  const [obsCategory, setObsCategory] = useState<string>('ipv4')
  const [obsValue, setObsValue] = useState('')
  const [addingObs, setAddingObs] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/monitoring/security/incidents/${params.id}`)
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      setData(d)
      setNewStatus(d.incident.status)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => { load() }, [load])

  const investigationId = data?.incident.investigationId ?? null

  const loadInvestigation = useCallback(async () => {
    if (!investigationId) return
    setLoadingInvestigation(true)
    try {
      const r = await fetch(`/api/monitoring/security/investigations/${investigationId}`)
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      const inv = d.investigation ?? d
      setInvestigation({
        id: inv.id,
        observables: inv.observables ?? [],
        notes: inv.notes ?? [],
        timeline: inv.timeline ?? [],
      })
    } catch {
      setInvestigation(null)
    } finally {
      setLoadingInvestigation(false)
    }
  }, [investigationId])

  const loadObservables = useCallback(async () => {
    if (!investigationId) return
    setLoadingObservables(true)
    try {
      const r = await fetch(`/api/monitoring/security/investigations/${investigationId}/observables`)
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      setObservables(d.observables ?? [])
    } catch {
      setObservables([])
    } finally {
      setLoadingObservables(false)
    }
  }, [investigationId])

  // Lazy-load investigation data when an investigation-dependent tab is opened.
  useEffect(() => {
    if (!investigationId) return
    if ((activeTab === 'notes' || activeTab === 'timeline') && !investigation) {
      loadInvestigation()
    }
    if (activeTab === 'observables' && observables === null) {
      loadObservables()
    }
  }, [activeTab, investigationId, investigation, loadInvestigation, observables, loadObservables])

  async function handleCreateInvestigation() {
    setCreatingInvestigation(true)
    try {
      const r = await fetch(`/api/monitoring/security/incidents/${params.id}/create-investigation`, {
        method: 'POST',
      })
      if (r.status === 409) {
        const refreshed = await fetch(`/api/monitoring/security/incidents/${params.id}`).then(r2 => r2.json())
        if (refreshed.incident?.investigationId) {
          router.push(`/security/investigations/${refreshed.incident.investigationId}`)
        }
        return
      }
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      router.push(`/security/investigations/${d.investigation.id}`)
    } catch {
      // non-critical — user can retry
    } finally {
      setCreatingInvestigation(false)
    }
  }

  async function patchStatus(status: string) {
    setUpdatingStatus(true)
    try {
      const r = await fetch(`/api/monitoring/security/incidents/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      await load()
    } finally {
      setUpdatingStatus(false)
    }
  }

  async function addObservable() {
    if (!investigationId || !obsValue.trim()) return
    setAddingObs(true)
    try {
      const r = await fetch(`/api/monitoring/security/investigations/${investigationId}/observables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: obsValue.trim(), category: obsCategory }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Unknown error' }))
        console.error('[addObservable] failed:', err)
        return
      }
      setObsValue('')
      setObservables(null)
      await loadObservables()
    } finally {
      setAddingObs(false)
    }
  }

  async function addNote() {
    if (!investigationId || !noteContent.trim()) return
    setSavingNote(true)
    try {
      await fetch(`/api/monitoring/security/investigations/${investigationId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      })
      setNoteContent('')
      await loadInvestigation()
    } finally {
      setSavingNote(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-status-error text-sm p-4 border border-status-error/20 bg-status-error/5 rounded-lg">
        Incident not found.
      </div>
    )
  }

  const { incident, events, actions, chatMessages } = data

  const currentIdx = STATUS_FLOW.indexOf(incident.status as typeof STATUS_FLOW[number])
  const nextStatus = currentIdx >= 0 && currentIdx < STATUS_FLOW.length - 1 ? STATUS_FLOW[currentIdx + 1] : null
  const isClosed = incident.status === 'closed'

  const verdictClass = (verdict: string) => {
    if (verdict === 'malicious') return 'bg-status-error/15 text-status-error'
    if (verdict === 'suspicious') return 'bg-status-warning/15 text-status-warning'
    if (verdict === 'benign') return 'bg-status-healthy/15 text-status-healthy'
    return 'bg-bg-raised text-text-muted'
  }

  const noInvestigationCta = (
    <div className="px-4 py-10 text-center text-sm text-text-muted">
      No investigation linked — click &apos;Open Investigation&apos; to enable this tab.
    </div>
  )

  return (
    <div className="p-6 max-w-5xl space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="p-1 rounded text-text-muted hover:text-text-primary transition-colors">
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-accent" />
            <h1 className="text-lg font-semibold text-text-primary">
              {incident.rootCauseSummary || 'Untitled Incident'}
            </h1>
          </div>
        </div>

        {/* Investigation button */}
        {incident.investigationId ? (
          <Link
            href={`/security/investigations/${incident.investigationId}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent text-accent hover:bg-accent/10 transition-colors"
          >
            <ExternalLink size={12} />
            View Investigation
          </Link>
        ) : (
          <button
            onClick={handleCreateInvestigation}
            disabled={creatingInvestigation}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {creatingInvestigation ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            Open Investigation
          </button>
        )}
      </div>

      {/* Incident header */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`text-xs font-bold px-2.5 py-1 rounded-lg ${
            incident.severity >= 80 ? 'bg-status-error/15 text-status-error' :
            incident.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
            'bg-bg-raised text-text-muted'
          }`}>
            Severity: {incident.severity}
          </span>
          <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
            incident.status === 'open' ? 'bg-status-warning/15 text-status-warning' :
            incident.status === 'triaged' ? 'bg-blue-400/15 text-blue-400' :
            incident.status === 'contained' ? 'bg-status-healthy/15 text-status-healthy' :
            'bg-bg-raised text-text-muted'
          }`}>
            {incident.status}
          </span>
          <span className="text-xs text-text-muted flex items-center gap-1">
            <Clock size={12} /> {new Date(incident.openedAt).toLocaleString()}
          </span>
        </div>

        {incident.attackerKey && (
          <div className="text-sm">
            <span className="text-text-muted">Attacker: </span>
            <code className="text-sm font-mono text-accent">{incident.attackerKey}</code>
          </div>
        )}

        {incident.hostKey && (
          <div className="text-sm">
            <span className="text-text-muted">Target: </span>
            <code className="text-sm font-mono text-text-secondary">{incident.hostKey}</code>
          </div>
        )}

        {/* Status controls */}
        <div className="flex items-center gap-2 pt-3 border-t border-border-subtle flex-wrap">
          <select
            value={newStatus}
            onChange={e => setNewStatus(e.target.value)}
            className="px-2 py-1 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none"
          >
            {STATUS_FLOW.map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <button
            onClick={() => patchStatus(newStatus)}
            disabled={updatingStatus || newStatus === incident.status}
            className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1"
          >
            {updatingStatus ? <Loader2 size={12} className="animate-spin" /> : <Edit3 size={12} />}
            Update
          </button>
          <button
            onClick={() => nextStatus && patchStatus(nextStatus)}
            disabled={updatingStatus || isClosed || !nextStatus}
            className="px-3 py-1 text-xs bg-status-warning/15 text-status-warning rounded hover:bg-status-warning/25 disabled:opacity-50 transition-colors flex items-center gap-1 ml-auto"
          >
            <ChevronsUp size={12} />
            {isClosed || !nextStatus ? 'Closed' : `Escalate to ${nextStatus}`}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-raised rounded-lg p-0.5 flex-wrap">
        {[
          { key: 'events' as const, label: `Events (${events.length})`, icon: FileText },
          { key: 'actions' as const, label: `Actions (${actions.length})`, icon: Shield },
          { key: 'chat' as const, label: `Chat (${chatMessages.length})`, icon: MessageSquare },
          { key: 'observables' as const, label: 'Observables', icon: Eye },
          { key: 'notes' as const, label: 'Notes', icon: FileText },
          { key: 'timeline' as const, label: 'Timeline', icon: Clock },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === t.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <t.icon size={12} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'events' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl divide-y divide-border-subtle">
          {events.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No events linked to this incident.</div>
          ) : (
            events.map(ev => (
              <Link
                key={ev.id}
                href={`/security/alerts/${ev.id}`}
                className="px-4 py-3 flex items-center gap-3 hover:bg-bg-raised transition-colors"
              >
                <span className={`text-xs font-bold w-10 shrink-0 text-center ${
                  ev.severity >= 80 ? 'text-status-error' :
                  ev.severity >= 50 ? 'text-status-warning' :
                  'text-text-muted'
                }`}>{ev.severity}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary">{ev.title}</div>
                  <div className="text-xs text-text-muted">
                    {ev.source} · {ev.type} · {new Date(ev.createdAt).toLocaleString()}
                  </div>
                </div>
                <ExternalLink size={12} className="text-text-muted shrink-0" />
              </Link>
            ))
          )}
        </div>
      )}

      {activeTab === 'actions' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl divide-y divide-border-subtle">
          {actions.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No actions taken on this incident yet.</div>
          ) : (
            actions.map(a => (
              <div key={a.id} className="px-4 py-3 flex items-center gap-3">
                {a.status === 'succeeded' ? (
                  <CheckCircle size={14} className="text-status-healthy shrink-0" />
                ) : a.status === 'failed' ? (
                  <XCircle size={14} className="text-status-error shrink-0" />
                ) : a.status === 'attempting' ? (
                  <Loader2 size={14} className="text-blue-400 shrink-0 animate-spin" />
                ) : (
                  <Clock size={14} className="text-status-warning shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary flex items-center gap-2">
                    <code className="font-mono">{a.actionType}</code>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      a.tier === 'auto' ? 'bg-blue-400/15 text-blue-400' :
                      a.tier === 'approve' ? 'bg-orange-400/15 text-orange-400' :
                      a.tier === 'escalate' ? 'bg-red-400/15 text-red-400' :
                      'bg-bg-raised text-text-muted'
                    }`}>{a.tier}</span>
                  </div>
                  <div className="text-xs text-text-muted">
                    Target: {a.target} · by {a.proposedBy}
                    {a.approvedBy && ` · approved by ${a.approvedBy}`}
                  </div>
                </div>
                <span className="text-xs text-text-muted shrink-0">
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">Warden Triage Log</span>
          </div>
          {chatMessages.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No chat messages for this incident.</div>
          ) : (
            <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto">
              {chatMessages.map(msg => (
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
      )}

      {activeTab === 'observables' && (
        <div className="space-y-4">
          {!investigationId ? (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">
              <div className="px-4 py-10 text-center text-sm text-text-muted">
                No investigation linked — click &apos;Open Investigation&apos; to enable observables.
              </div>
            </div>
          ) : (
            <>
              {/* Add Observable form */}
              <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Eye size={14} className="text-text-muted" />
                  <span className="text-sm font-medium text-text-primary">Add Observable</span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={obsCategory}
                    onChange={e => setObsCategory(e.target.value)}
                    className="px-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent"
                  >
                    {['ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn'].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={obsValue}
                    onChange={e => setObsValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addObservable() }}
                    placeholder="Value (e.g. 1.2.3.4, evil.com)"
                    className="flex-1 px-3 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent font-mono"
                  />
                  <button
                    onClick={addObservable}
                    disabled={addingObs || !obsValue.trim()}
                    className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1 shrink-0"
                  >
                    {addingObs ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    Add
                  </button>
                </div>
              </div>

              {/* Observables table */}
              <div className="bg-bg-surface border border-border-subtle rounded-xl">
                <div className="px-4 py-3 border-b border-border-subtle">
                  <span className="text-sm font-medium text-text-primary">
                    Observables{observables ? ` (${observables.length})` : ''}
                  </span>
                </div>
                {loadingObservables ? (
                  <div className="px-4 py-10 flex justify-center"><Loader2 size={20} className="animate-spin text-accent" /></div>
                ) : !observables || observables.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">No observables yet — add one above.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-subtle text-text-muted text-left">
                          <th className="px-4 py-2 font-medium">Value</th>
                          <th className="px-4 py-2 font-medium">Category</th>
                          <th className="px-4 py-2 font-medium">Role</th>
                          <th className="px-4 py-2 font-medium">Verdict</th>
                          <th className="px-4 py-2 font-medium">Confidence</th>
                          <th className="px-4 py-2 font-medium">First Seen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle">
                        {observables.map(obs => (
                          <tr key={obs.id} className="hover:bg-bg-raised transition-colors">
                            <td className="px-4 py-2 font-mono text-text-primary truncate max-w-48">{obs.displayValue || obs.value}</td>
                            <td className="px-4 py-2 text-text-muted">{obs.category}</td>
                            <td className="px-4 py-2 text-text-muted">{obs.role}</td>
                            <td className="px-4 py-2">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${verdictClass(obs.verdict)}`}>
                                {obs.verdict}
                              </span>
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
            </>
          )}
        </div>
      )}

      {activeTab === 'notes' && (
        <div className="space-y-4">
          {!investigationId ? (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">{noInvestigationCta}</div>
          ) : (
            <>
              <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <FileText size={14} className="text-text-muted" />
                  <span className="text-sm font-medium text-text-primary">Add Note</span>
                </div>
                <textarea
                  value={noteContent}
                  onChange={e => setNoteContent(e.target.value)}
                  placeholder="Add a note to the linked investigation..."
                  rows={3}
                  className="w-full px-3 py-2 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none"
                />
                <div className="flex justify-end mt-2">
                  <button
                    onClick={addNote}
                    disabled={savingNote || !noteContent.trim()}
                    className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1"
                  >
                    {savingNote ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    Add Note
                  </button>
                </div>
              </div>

              <div className="bg-bg-surface border border-border-subtle rounded-xl">
                <div className="px-4 py-3 border-b border-border-subtle">
                  <span className="text-sm font-medium text-text-primary">
                    Notes{investigation ? ` (${investigation.notes.length})` : ''}
                  </span>
                </div>
                {loadingInvestigation ? (
                  <div className="px-4 py-10 flex justify-center"><Loader2 size={20} className="animate-spin text-accent" /></div>
                ) : !investigation || investigation.notes.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">No notes yet</div>
                ) : (
                  <div className="divide-y divide-border-subtle">
                    {investigation.notes.map(note => (
                      <div key={note.id} className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            note.authorType === 'warden'
                              ? 'bg-purple-400/15 text-purple-400'
                              : 'bg-accent/15 text-accent'
                          }`}>
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
            </>
          )}
        </div>
      )}

      {activeTab === 'timeline' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">
              Timeline{investigation ? ` (${investigation.timeline.length})` : ''}
            </span>
          </div>
          {!investigationId ? noInvestigationCta : loadingInvestigation ? (
            <div className="px-4 py-10 flex justify-center"><Loader2 size={20} className="animate-spin text-accent" /></div>
          ) : !investigation || investigation.timeline.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No timeline events</div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {investigation.timeline.map(entry => (
                <div key={entry.id} className="px-4 py-3 flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                    <div className="w-px flex-1 bg-border-subtle mt-1" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{entry.title}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted">{entry.eventType}</span>
                      {entry.source && (
                        <span className="text-[10px] text-text-muted">via {entry.source}</span>
                      )}
                    </div>
                    {entry.description && (
                      <div className="text-xs text-text-muted mt-0.5">{entry.description}</div>
                    )}
                    <div className="text-[10px] text-text-muted mt-0.5">{new Date(entry.eventTime).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
