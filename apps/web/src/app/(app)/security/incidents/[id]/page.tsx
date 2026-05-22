'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, AlertTriangle, Shield, Clock, CheckCircle, XCircle, MessageSquare, FileText, Loader2 } from 'lucide-react'

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

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<IncidentData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'events' | 'actions' | 'chat'>('events')

  useEffect(() => {
    fetch(`/api/monitoring/security/incidents/${params.id}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setLoading(false) })
  }, [params.id])

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

  return (
    <div className="p-6 max-w-5xl space-y-4">
      {/* Header */}
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
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-raised rounded-lg p-0.5">
        {[
          { key: 'events' as const, label: `Events (${events.length})`, icon: FileText },
          { key: 'actions' as const, label: `Actions (${actions.length})`, icon: Shield },
          { key: 'chat' as const, label: `Chat (${chatMessages.length})`, icon: MessageSquare },
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
              <div key={ev.id} className="px-4 py-3 flex items-center gap-3">
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
              </div>
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
    </div>
  )
}
