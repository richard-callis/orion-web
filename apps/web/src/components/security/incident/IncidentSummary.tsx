'use client'

import { useState } from 'react'
import { ChevronsUp, Clock, Edit3, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { STATUS_FLOW, type Incident } from './types'

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-status-warning/15 text-status-warning',
  triaged: 'bg-blue-400/15 text-blue-400',
  contained: 'bg-status-healthy/15 text-status-healthy',
}

const severityBadge = (sev: number) =>
  sev >= 80 ? 'bg-status-error/15 text-status-error' : sev >= 50 ? 'bg-status-warning/15 text-status-warning' : 'bg-bg-raised text-text-muted'

export function IncidentSummary({ incident, error, onStatusChange }: {
  incident: Incident
  error: string | null
  onStatusChange: (status: string) => Promise<void>
}) {
  // null = "no pending change" → the select shows the current status
  const [picked, setPicked] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const selected = picked ?? incident.status

  const idx = STATUS_FLOW.indexOf(incident.status as typeof STATUS_FLOW[number])
  const nextStatus = idx >= 0 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null
  const isClosed = incident.status === 'closed'

  const apply = async (status: string) => {
    setUpdating(true)
    try {
      await onStatusChange(status)
      setPicked(null)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-xs font-bold px-2.5 py-1 rounded-lg ${severityBadge(incident.severity)}`}>
          Severity: {incident.severity}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_BADGE[incident.status] ?? 'bg-bg-raised text-text-muted'}`}>
          {incident.status}
        </span>
        <span className="text-xs text-text-muted flex items-center gap-1">
          <Clock size={12} aria-hidden /> {new Date(incident.openedAt).toLocaleString()}
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

      {error && <p role="alert" className="text-xs text-status-error pt-2">{error}</p>}

      <div className="flex items-center gap-2 pt-3 border-t border-border-subtle flex-wrap">
        <Select aria-label="Incident status" value={selected} onChange={e => setPicked(e.target.value)} className="w-auto px-2 py-1 text-xs">
          {STATUS_FLOW.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </Select>
        <Button onClick={() => apply(selected)} disabled={updating || selected === incident.status} className="px-3 py-1">
          {updating ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Edit3 size={12} aria-hidden />}
          Update
        </Button>
        <button
          onClick={() => nextStatus && apply(nextStatus)}
          disabled={updating || isClosed || !nextStatus}
          className="px-3 py-1 text-xs bg-status-warning/15 text-status-warning rounded hover:bg-status-warning/25 disabled:opacity-50 transition-colors flex items-center gap-1 ml-auto"
        >
          <ChevronsUp size={12} aria-hidden />
          {isClosed || !nextStatus ? 'Closed' : `Escalate to ${nextStatus}`}
        </button>
      </div>
    </div>
  )
}
