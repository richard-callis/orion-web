'use client'

import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, CheckCircle, XCircle, Clock, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react'

interface Approval {
  id: string
  actionType: string
  target: string
  tier: string
  proposedBy: string
  incidentId: string | null
  payload: unknown
  createdAt: string
  incident: {
    severity: number
    summary: string | null
    attackerKey: string | null
  } | null
}

export default function SecurityApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/monitoring/security/approvals')
      const data = await res.json()
      setApprovals(data.pending ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const act = async (id: string, action: 'approve' | 'deny') => {
    setActing(id)
    try {
      await fetch(`/api/monitoring/security/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: note[id] ?? '' }),
      })
      await load()
    } finally { setActing(null) }
  }

  const getActionLabel = (actionType: string) => {
    const labels: Record<string, string> = {
      crowdsec_decision_create: 'Block IP (CrowdSec)',
      crowdsec_decision_delete: 'Unblock IP (CrowdSec)',
      wazuh_active_response: 'Active Response (Wazuh)',
      firewall_block: 'Firewall Block',
      investigate: 'Investigate (Elasticsearch)',
      incident_close: 'Close Incident',
      suppression_add: 'Add Suppression',
    }
    return labels[actionType] || actionType
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-orange-400" />
          <h1 className="text-lg font-semibold text-text-primary">Security Action Approvals</h1>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={e => setFilter(e.target.value as 'pending' | 'all')}
            className="px-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none">
            <option value="pending">Pending only</option>
            <option value="all">All</option>
          </select>
          <button onClick={load} className="p-1.5 rounded text-text-muted hover:text-text-primary border border-border-subtle transition-colors">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : approvals.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
          No pending approvals — all clear.
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map(a => (
            <div key={a.id} className="rounded-lg border-2 border-orange-500 bg-orange-500/5 overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit bg-black/5">
                <Clock size={12} className="text-orange-400" />
                <span className="text-xs font-semibold text-orange-400">PENDING APPROVAL</span>
                <span className="text-[10px] text-text-muted ml-auto">
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </div>

              <div className="p-4 space-y-3">
                {/* Action info */}
                <div className="flex items-start gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-status-warning shrink-0" />
                      <code className="text-sm font-medium text-accent">{getActionLabel(a.actionType)}</code>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-400/15 text-orange-400">
                        {a.tier}
                      </span>
                    </div>

                    <div className="text-xs text-text-secondary">
                      <span className="text-text-muted">Target: </span>
                      <code className="font-mono">{a.target}</code>
                    </div>

                    {/* Incident context */}
                    {a.incident && (
                      <div className="text-xs bg-bg-raised rounded p-2 border border-border-subtle">
                        <div className="text-text-muted mb-0.5">Related incident:</div>
                        <div className="text-text-primary font-medium">
                          {a.incident.summary || 'Untitled incident'}
                        </div>
                        <div className="text-text-muted">
                          {a.incident.attackerKey || 'unknown attacker'}
                          {a.incident.severity >= 80 && ' | '}
                          <span className="text-status-error ml-1">Severity: {a.incident.severity}</span>
                        </div>
                      </div>
                    )}

                    {/* Payload preview */}
                    {(a.payload as any) && typeof (a.payload as any) === 'object' && (
                      <pre className="text-[11px] font-mono bg-bg-raised rounded px-2 py-1.5 text-text-secondary border border-border-subtle overflow-x-auto">
                        {JSON.stringify(a.payload, null, 2).slice(0, 300)}
                        {JSON.stringify(a.payload, null, 2).length > 300 ? '...' : ''}
                      </pre>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    value={note[a.id] ?? ''}
                    onChange={e => setNote(prev => ({ ...prev, [a.id]: e.target.value }))}
                    placeholder="Optional note to propose..."
                    className="w-full px-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
                  />
                  <button
                    onClick={() => act(a.id, 'deny')}
                    disabled={acting === a.id}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <XCircle size={12} /> Deny
                  </button>
                  <button
                    onClick={() => act(a.id, 'approve')}
                    disabled={acting === a.id}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {acting === a.id ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <CheckCircle size={12} />
                    )}
                    Approve
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
