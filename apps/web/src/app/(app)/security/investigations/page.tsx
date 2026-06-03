'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Loader2, RefreshCw, Search, Plus, FolderOpen, AlertTriangle, CheckCircle, Clock, Archive } from 'lucide-react'

interface Investigation {
  id: string
  name: string
  status: string
  severity: number
  tlp: string
  tags: string[]
  startedAt: string | null
  resolvedAt: string | null
  // API returns flat counts (not _count) — see investigations/route.ts mapper
  incidentCount: number
  noteCount: number
  observableCount: number
}

export default function InvestigationsPage() {
  const [investigations, setInvestigations] = useState<Investigation[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (search) params.set('search', search)
      const data = await fetch(`/api/monitoring/security/investigations?${params}`).then(r => r.json())
      setInvestigations(data.investigations ?? [])
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search])

  useEffect(() => { load() }, [load])

  const statusIcon = (status: string) => {
    if (status === 'open') return <Clock size={10} className="inline mr-1" />
    if (status === 'active') return <AlertTriangle size={10} className="inline mr-1" />
    if (status === 'suspended') return <Archive size={10} className="inline mr-1" />
    if (status === 'resolved') return <CheckCircle size={10} className="inline mr-1" />
    return <Archive size={10} className="inline mr-1" />
  }

  const statusClass = (status: string) => {
    if (status === 'open') return 'bg-status-warning/15 text-status-warning'
    if (status === 'active') return 'bg-red-400/15 text-red-400'
    if (status === 'suspended') return 'bg-blue-400/15 text-blue-400'
    if (status === 'resolved') return 'bg-status-healthy/15 text-status-healthy'
    return 'bg-bg-raised text-text-muted'
  }

  const severityClass = (sev: number) => {
    if (sev >= 80) return 'bg-status-error/15 text-status-error'
    if (sev >= 50) return 'bg-status-warning/15 text-status-warning'
    return 'bg-bg-raised text-text-muted'
  }

  const tlpClass = (tlp: string) => {
    if (tlp === 'red') return 'bg-status-error/15 text-status-error'
    if (tlp === 'amber') return 'bg-status-warning/15 text-status-warning'
    if (tlp === 'green') return 'bg-status-healthy/15 text-status-healthy'
    return 'bg-bg-raised text-text-muted'
  }

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderOpen size={18} className="text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Investigations</h1>
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
              placeholder="Search investigations..."
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
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : investigations.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
          No investigations found.
        </div>
      ) : (
        <div className="space-y-2">
          {investigations.map(inv => (
            <Link key={inv.id} href={`/security/investigations/${inv.id}`}
              className="block rounded-xl border border-border-subtle hover:border-accent/40 bg-bg-surface transition-colors">
              <div className="flex items-center gap-4 px-4 py-3">
                {/* Severity badge */}
                <div className={`flex items-center justify-center w-11 h-11 rounded-lg shrink-0 ${severityClass(inv.severity)}`}>
                  <span className="text-sm font-bold">{inv.severity}</span>
                </div>

                {/* Investigation details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {inv.name}
                    </span>
                    {inv.tags?.slice(0, 2).map((tag: string) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-text-muted flex items-center gap-2">
                    <span>{inv.incidentCount} incidents</span>
                    <span>&middot;</span>
                    <span>{inv.observableCount} observables</span>
                    <span>&middot;</span>
                    <span>{inv.noteCount} notes</span>
                    {inv.startedAt && (
                      <>
                        <span>&middot;</span>
                        <span>{new Date(inv.startedAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${tlpClass(inv.tlp)}`}>
                    {inv.tlp}
                  </span>
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${statusClass(inv.status)}`}>
                    {statusIcon(inv.status)}{inv.status}
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
