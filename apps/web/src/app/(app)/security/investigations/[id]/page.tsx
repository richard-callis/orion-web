'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  Loader2, ArrowLeft, AlertTriangle, Shield, Clock, FileText,
  Eye, Link as LinkIcon, Edit3, Plus, Trash2, CheckCircle,
  AlertOctagon, Tag, Layers
} from 'lucide-react'
import Link from 'next/link'

interface Investigation {
  id: string
  name: string
  status: string
  severity: number
  tlp: string
  tags: string[]
  mitreAttackIds: string[]
  startedAt: string | null
  resolvedAt: string | null
  resolution: string | null
  createdBy: string | null
  incidents: Array<{
    id: string
    status: string
    severity: number
    attackerKey: string | null
    rootCauseSummary: string | null
    openedAt: string
  }>
  notes: Array<{
    id: string
    content: string
    author: string
    authorType: string
    createdAt: string
  }>
  observables: Array<{
    id: string
    value: string
    displayValue: string | null
    category: string
    role: string
    verdict: string
    confidence: number
    context: string | null
    firstSeen: string
    lastSeen: string | null
  }>
  timeline: Array<{
    id: string
    eventTime: string
    eventType: string
    title: string
    description: string | null
    source: string | null
  }>
}

export default function InvestigationDetailPage() {
  const params = useParams()
  const router = useRouter()
  const investigationId = params.id as string
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'overview' | 'observables' | 'notes' | 'timeline'>('overview')
  const [noteContent, setNoteContent] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [newStatus, setNewStatus] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await fetch(`/api/monitoring/security/investigations/${investigationId}`).then(r => r.json())
      setInvestigation(data.investigation ?? data)
      setNewStatus(data.investigation?.status ?? data?.status ?? 'open')
    } catch {
      router.push('/security/investigations')
    } finally {
      setLoading(false)
    }
  }, [investigationId, router])

  useEffect(() => { load() }, [load])

  const addNote = async () => {
    if (!noteContent.trim()) return
    setSavingNote(true)
    try {
      await fetch(`/api/monitoring/security/investigations/${investigationId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      })
      setNoteContent('')
      load()
    } finally {
      setSavingNote(false)
    }
  }

  const updateStatus = async () => {
    setUpdatingStatus(true)
    try {
      await fetch(`/api/monitoring/security/investigations/${investigationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      load()
    } finally {
      setUpdatingStatus(false)
    }
  }

  const deleteObservable = async (obsId: string) => {
    if (!confirm('Delete this observable?')) return
    try {
      await fetch(`/api/monitoring/security/investigations/${investigationId}/observables/${obsId}`, {
        method: 'DELETE',
      })
      load()
    } catch {}
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    )
  }

  if (!investigation) {
    return (
      <div className="p-6 text-center text-text-muted">Investigation not found</div>
    )
  }

  const verdictClass = (verdict: string) => {
    if (verdict === 'malicious') return 'bg-status-error/15 text-status-error'
    if (verdict === 'suspicious') return 'bg-status-warning/15 text-status-warning'
    if (verdict === 'benign') return 'bg-status-healthy/15 text-status-healthy'
    return 'bg-bg-raised text-text-muted'
  }

  return (
    <div className="p-6 max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="p-1.5 rounded hover:bg-bg-raised text-text-muted transition-colors">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">{investigation.name}</h1>
          <div className="text-xs text-text-muted flex items-center gap-2 mt-0.5">
            <span>ID: {investigationId.slice(0, 8)}</span>
            {investigation.createdBy && <span>· Created by {investigation.createdBy}</span>}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Status badges */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold uppercase px-2 py-1 rounded ${
              investigation.status === 'open' ? 'bg-status-warning/15 text-status-warning' :
              investigation.status === 'active' ? 'bg-red-400/15 text-red-400' :
              investigation.status === 'suspended' ? 'bg-blue-400/15 text-blue-400' :
              investigation.status === 'resolved' ? 'bg-status-healthy/15 text-status-healthy' :
              'bg-bg-raised text-text-muted'
            }`}>
              {investigation.status}
            </span>
            <span className={`text-xs font-bold uppercase px-2 py-1 rounded ${
              investigation.tlp === 'red' ? 'bg-status-error/15 text-status-error' :
              investigation.tlp === 'amber' ? 'bg-status-warning/15 text-status-warning' :
              investigation.tlp === 'green' ? 'bg-status-healthy/15 text-status-healthy' :
              'bg-bg-raised text-text-muted'
            }`}>
              TLP:{' '}{investigation.tlp}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${
              investigation.severity >= 80 ? 'bg-status-error/15 text-status-error' :
              investigation.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
              'bg-bg-raised text-text-muted'
            }`}>
              Severity: {investigation.severity}
            </span>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4 text-xs text-text-muted ml-auto">
            <span className="flex items-center gap-1"><LinkIcon size={12} /> {investigation.incidents.length} incidents</span>
            <span className="flex items-center gap-1"><Eye size={12} /> {investigation.observables.length} observables</span>
            <span className="flex items-center gap-1"><FileText size={12} /> {investigation.notes.length} notes</span>
            <span className="flex items-center gap-1"><Clock size={12} /> {investigation.timeline.length} events</span>
          </div>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {investigation.tags?.length ? investigation.tags.map(tag => (
            <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-bg-raised text-text-muted flex items-center gap-1">
              <Tag size={10} /> {tag}
            </span>
          )) : null}
          {investigation.mitreAttackIds?.length ? investigation.mitreAttackIds.map(id => (
            <span key={id} className="text-[10px] px-2 py-0.5 rounded-full bg-purple-400/15 text-purple-400 flex items-center gap-1">
              <Layers size={10} /> {id}
            </span>
          )) : null}
        </div>

        {/* Status update controls */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border-subtle">
          <select
            value={newStatus}
            onChange={e => setNewStatus(e.target.value)}
            className="px-2 py-1 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none"
          >
            <option value="open">Open</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <button
            onClick={updateStatus}
            disabled={updatingStatus || newStatus === investigation.status}
            className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {updatingStatus ? <Loader2 size={12} className="animate-spin inline" /> : <Edit3 size={12} className="inline" />}{' '}
            Update
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-raised rounded-lg p-0.5">
        {(['overview', 'observables', 'notes', 'timeline'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
              activeTab === tab ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Linked incidents */}
          {investigation.incidents.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">
              <div className="px-4 py-3 border-b border-border-subtle">
                <span className="text-sm font-medium text-text-primary">Linked Incidents</span>
              </div>
              <div className="divide-y divide-border-subtle">
                {investigation.incidents.map(inc => (
                  <Link
                    key={inc.id}
                    href={`/security/incidents/${inc.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-bg-raised transition-colors"
                  >
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                      inc.severity >= 80 ? 'bg-status-error/15 text-status-error' :
                      inc.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
                      'bg-bg-raised text-text-muted'
                    }`}>
                      {inc.severity}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary truncate">{inc.rootCauseSummary || 'Untitled'}</div>
                      <div className="text-xs text-text-muted">{inc.attackerKey || 'unknown'}</div>
                    </div>
                    <span className="text-[10px] text-text-muted">{new Date(inc.openedAt).toLocaleDateString()}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Observables summary */}
          {investigation.observables.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary">Key Observables</span>
                <button onClick={() => setActiveTab('observables')} className="text-xs text-accent hover:underline">
                  View all ({investigation.observables.length})
                </button>
              </div>
              <div className="divide-y divide-border-subtle">
                {investigation.observables.slice(0, 5).map(obs => (
                  <div key={obs.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-xs font-mono text-text-primary flex-1 truncate">{obs.displayValue || obs.value}</span>
                    <span className="text-[10px] text-text-muted">{obs.category}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${verdictClass(obs.verdict)}`}>
                      {obs.verdict}
                    </span>
                    <span className="text-[10px] text-text-muted">{obs.confidence}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resolution */}
          {investigation.resolution && (
            <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle size={14} className="text-status-healthy" />
                <span className="text-sm font-medium text-text-primary">Resolution</span>
              </div>
              <p className="text-sm text-text-muted whitespace-pre-wrap">{investigation.resolution}</p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'observables' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">Observables ({investigation.observables.length})</span>
          </div>
          {investigation.observables.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No observables recorded</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-subtle text-text-muted text-left">
                  <th className="px-4 py-2 font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Verdict</th>
                  <th className="px-4 py-2 font-medium">Confidence</th>
                  <th className="px-4 py-2 font-medium">First Seen</th>
                  <th className="px-4 py-2 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {investigation.observables.map(obs => (
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
                    <td className="px-4 py-2">
                      <button onClick={() => deleteObservable(obs.id)} className="text-text-muted hover:text-status-error transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'notes' && (
        <div className="space-y-4">
          {/* Add note */}
          <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileText size={14} className="text-text-muted" />
              <span className="text-sm font-medium text-text-primary">Add Note</span>
            </div>
            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              placeholder="Add a note to this investigation..."
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

          {/* Notes list */}
          <div className="bg-bg-surface border border-border-subtle rounded-xl">
            <div className="px-4 py-3 border-b border-border-subtle">
              <span className="text-sm font-medium text-text-primary">Notes ({investigation.notes.length})</span>
            </div>
            {investigation.notes.length === 0 ? (
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
        </div>
      )}

      {activeTab === 'timeline' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">Timeline ({investigation.timeline.length})</span>
          </div>
          {investigation.timeline.length === 0 ? (
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
