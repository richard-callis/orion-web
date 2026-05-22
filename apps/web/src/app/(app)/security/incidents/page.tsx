'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Shield, Loader2, RefreshCw, Search, XCircle, AlertTriangle, CheckCircle, Clock } from 'lucide-react'

interface Incident {
  id: string
  status: string
  severity: number
  rootCauseSummary: string | null
  attackerKey: string | null
  hostKey: string | null
  openedAt: string
  closedAt: string | null
  eventCount: number
  actionCount: number
}

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (search) params.set('search', search)
      const data = await fetch(`/api/monitoring/security/incidents?${params}`).then(r => r.json())
      setIncidents(data.incidents ?? [])
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search])

  useEffect(() => { load() }, [load])

  const filtered = incidents.filter(inc => {
    if (filter && !inc.rootCauseSummary?.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Security Incidents</h1>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-64">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-2 text-text-muted" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Search attacker key..."
              className="w-full pl-8 pr-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <button onClick={load} className="p-1.5 rounded text-text-muted hover:text-text-primary border border-border-subtle transition-colors">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="triaged">Triaged</option>
          <option value="contained">Contained</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : incidents.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
          No incidents found.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(inc => (
            <Link key={inc.id} href={`/security/incidents/${inc.id}`}
              className="block rounded-xl border border-border-subtle hover:border-accent/40 bg-bg-surface transition-colors">
              <div className="flex items-center gap-4 px-4 py-3">
                {/* Severity badge */}
                <div className={`flex items-center justify-center w-11 h-11 rounded-lg shrink-0 ${
                  inc.severity >= 80 ? 'bg-status-error/15 text-status-error' :
                  inc.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
                  'bg-bg-raised text-text-muted'
                }`}>
                  <AlertTriangle size={20} />
                </div>

                {/* Incident details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {inc.rootCauseSummary || 'Untitled incident'}
                    </span>
                  </div>
                  <div className="text-xs text-text-muted flex items-center gap-2">
                    <span>{inc.attackerKey || 'unknown attacker'}</span>
                    {inc.hostKey && <span>&middot; {inc.hostKey}</span>}
                    <span>&middot; {inc.eventCount} events</span>
                    {inc.actionCount > 0 && <span>&middot; {inc.actionCount} actions</span>}
                  </div>
                </div>

                {/* Status badge */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                    inc.status === 'open' ? 'bg-status-warning/15 text-status-warning' :
                    inc.status === 'triaged' ? 'bg-blue-400/15 text-blue-400' :
                    inc.status === 'contained' ? 'bg-status-healthy/15 text-status-healthy' :
                    'bg-bg-raised text-text-muted'
                  }`}>
                    {inc.status === 'open' && <><Clock size={10} className="inline mr-1" />Open</>}
                    {inc.status === 'triaged' && <><Shield size={10} className="inline mr-1" />Triaged</>}
                    {inc.status === 'contained' && <><CheckCircle size={10} className="inline mr-1" />Contained</>}
                    {inc.status === 'closed' && <><XCircle size={10} className="inline mr-1" />Closed</>}
                  </span>
                  <span className="text-[10px] text-text-muted shrink-0">
                    {new Date(inc.openedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
