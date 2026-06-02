'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Shield, Globe, Database, AlertTriangle, CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react'
import Link from 'next/link'

const sourceIcons: Record<string, React.ElementType> = {
  crowdsec: Shield,
  ntopng: Globe,
  wazuh: Database,
  elk: Database,
  falco: Shield,
}

const sourceColors: Record<string, string> = {
  crowdsec: 'text-blue-400',
  ntopng: 'text-green-400',
  wazuh: 'text-orange-400',
  elk: 'text-purple-400',
  falco: 'text-red-400',
}

interface AlertEvent {
  id: string
  type: string
  source: string
  severity: number
  title: string
  description: string | null
  rawEvent: Record<string, unknown> | null
  acknowledged: boolean
  acknowledgedAt: string | null
  dedupKey: string | null
  firstSeen: string | null
  lastSeen: string | null
  createdAt: string
  incidentId: string | null
  environmentId: string | null
}

function SeverityBadge({ severity }: { severity: number }) {
  if (severity >= 80) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border bg-red-500/20 text-red-400 border-red-500/30"><XCircle size={10} />{severity} Critical</span>
  if (severity >= 50) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border bg-orange-500/20 text-orange-400 border-orange-500/30"><AlertTriangle size={10} />{severity} High</span>
  if (severity >= 20) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border bg-yellow-500/20 text-yellow-400 border-yellow-500/30"><AlertTriangle size={10} />{severity} Medium</span>
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle2 size={10} />{severity} Low</span>
}

export default function AlertDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [event, setEvent] = useState<AlertEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [rawExpanded, setRawExpanded] = useState(false)
  const [acking, setAcking] = useState(false)

  useEffect(() => {
    fetch(`/api/monitoring/security/alerts/${params.id}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then(d => { setEvent(d.event); setLoading(false) })
      .catch(() => { setLoading(false) })
  }, [params.id])

  async function acknowledge() {
    if (!event || event.acknowledged) return
    setAcking(true)
    await fetch('/api/monitoring/security/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [event.id] }),
    })
    setEvent(prev => prev ? { ...prev, acknowledged: true, acknowledgedAt: new Date().toISOString() } : prev)
    setAcking(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    )
  }

  if (!event) {
    return (
      <div className="text-status-error text-sm p-4 border border-status-error/20 bg-status-error/5 rounded-lg">
        Alert not found.
      </div>
    )
  }

  const Icon = sourceIcons[event.source] || Shield

  return (
    <div className="p-6 max-w-4xl space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="p-1 rounded text-text-muted hover:text-text-primary transition-colors">
            <ArrowLeft size={16} />
          </button>
          <Icon size={18} className={sourceColors[event.source] || 'text-text-muted'} />
          <h1 className="text-lg font-semibold text-text-primary">{event.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {!event.acknowledged && (
            <button
              onClick={acknowledge}
              disabled={acking}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-border-subtle text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
            >
              {acking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Acknowledge
            </button>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <SeverityBadge severity={event.severity} />
          <span className="text-xs text-text-muted px-2 py-0.5 rounded bg-bg-raised font-mono">{event.type}</span>
          <span className="text-xs text-text-muted px-2 py-0.5 rounded bg-bg-raised">{event.source}</span>
          {event.acknowledged && (
            <span className="text-xs text-status-success flex items-center gap-1">
              <CheckCircle2 size={12} /> Acknowledged
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-text-muted">First seen: </span>
            <span className="text-text-primary">{event.firstSeen ? new Date(event.firstSeen).toLocaleString() : new Date(event.createdAt).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-text-muted">Last seen: </span>
            <span className="text-text-primary">{event.lastSeen ? new Date(event.lastSeen).toLocaleString() : '—'}</span>
          </div>
          {event.dedupKey && (
            <div className="col-span-2">
              <span className="text-text-muted">Dedup key: </span>
              <code className="text-text-primary font-mono">{event.dedupKey}</code>
            </div>
          )}
        </div>

        {event.incidentId && (
          <Link
            href={`/security/incidents/${event.incidentId}`}
            className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
          >
            <ExternalLink size={12} />
            Linked to incident
          </Link>
        )}
      </div>

      {/* Description */}
      {event.description && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
          <div className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wide">Description</div>
          <p className="text-sm text-text-primary leading-relaxed">{event.description}</p>
        </div>
      )}

      {/* Raw event */}
      {event.rawEvent && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
          <button
            onClick={() => setRawExpanded(e => !e)}
            className="w-full px-4 py-3 flex items-center justify-between text-xs font-medium text-text-muted hover:text-text-primary transition-colors border-b border-border-subtle"
          >
            <span className="uppercase tracking-wide">Raw Event</span>
            <span>{rawExpanded ? '▲' : '▼'}</span>
          </button>
          {rawExpanded && (
            <pre className="p-4 text-xs font-mono text-text-secondary overflow-x-auto bg-bg-raised leading-relaxed max-h-96 overflow-y-auto">
              {JSON.stringify(event.rawEvent, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
