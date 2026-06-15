'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  AlertTriangle, CheckCircle2, XCircle, Loader2, Shield, Globe,
  Database, CheckCheck, ChevronDown, RefreshCw,
} from 'lucide-react'
import Link from 'next/link'
import { type NotifyMessage } from '@/lib/security/stream-utils'

// ── Source metadata ──────────────────────────────────────────────────────────

const SOURCE_ICONS: Record<string, React.ElementType> = {
  crowdsec: Shield,
  ntopng: Globe,
  wazuh: Database,
  elk: Database,
  falco: Shield,
}

const SOURCE_COLORS: Record<string, string> = {
  crowdsec: 'text-blue-400',
  ntopng: 'text-green-400',
  wazuh: 'text-orange-400',
  elk: 'text-purple-400',
  falco: 'text-red-400',
}

const ALL_SOURCES = ['crowdsec', 'falco', 'wazuh', 'ntopng', 'elk']

// ── Filter types ─────────────────────────────────────────────────────────────

type AckFilter = 'all' | 'unacked' | 'acked'
type TimeMode = 'quick' | 'absolute'

interface Filters {
  sources: string[]
  minSeverity: number
  ackFilter: AckFilter
  timeMode: TimeMode
  quickMinutes: number
  from: string
  to: string
}

const DEFAULT_FILTERS: Filters = {
  sources: [],
  minSeverity: 0,
  ackFilter: 'all',
  timeMode: 'quick',
  quickMinutes: 60,
  from: '',
  to: '',
}

const QUICK_RANGES = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h',  minutes: 60 },
  { label: '6h',  minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d',  minutes: 10080 },
  { label: '30d', minutes: 43200 },
]

const SEV_OPTIONS: { label: string; value: number }[] = [
  { label: 'All severities', value: 0 },
  { label: 'Low+  (≥1)',     value: 1 },
  { label: 'Medium+ (≥20)',  value: 20 },
  { label: 'High+  (≥50)',   value: 50 },
  { label: 'Critical (≥80)', value: 80 },
]

const ACK_OPTIONS: { label: string; value: AckFilter }[] = [
  { label: 'All',              value: 'all' },
  { label: 'Unacknowledged',   value: 'unacked' },
  { label: 'Acknowledged',     value: 'acked' },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function toDatetimeLocal(d: Date): string {
  // "YYYY-MM-DDThh:mm" — what datetime-local inputs expect
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildQuery(f: Filters, page: number, limit = 50): string {
  const p = new URLSearchParams({ limit: String(limit), page: String(page) })
  if (f.sources.length > 0) p.set('source', f.sources.join(','))
  if (f.minSeverity > 0) p.set('severity', String(f.minSeverity))
  if (f.ackFilter === 'unacked') p.set('acknowledged', 'false')
  if (f.ackFilter === 'acked')   p.set('acknowledged', 'true')
  if (f.timeMode === 'absolute') {
    if (f.from) p.set('from', new Date(f.from).toISOString())
    if (f.to)   p.set('to',   new Date(f.to).toISOString())
  } else {
    p.set('minutes', String(f.quickMinutes))
  }
  return `/api/monitoring/security/alerts?${p}`
}

function matchesFilters(alert: any, f: Filters): boolean {
  if (f.sources.length > 0 && !f.sources.includes(alert.source)) return false
  if (f.minSeverity > 0 && alert.severity < f.minSeverity) return false
  if (f.ackFilter === 'unacked' && alert.acknowledged) return false
  if (f.ackFilter === 'acked'   && !alert.acknowledged) return false
  return true
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: number }) {
  let cls = ''
  let icon = null
  if (severity >= 80) {
    cls = 'bg-red-500/20 text-red-400 border-red-500/30'
    icon = <XCircle size={10} />
  } else if (severity >= 50) {
    cls = 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    icon = <AlertTriangle size={10} />
  } else if (severity >= 20) {
    cls = 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    icon = <AlertTriangle size={10} />
  } else {
    cls = 'bg-green-500/20 text-green-400 border-green-500/30'
    icon = <CheckCircle2 size={10} />
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {icon}{severity}
    </span>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({
  filters,
  onChange,
  onRefresh,
  loading,
}: {
  filters: Filters
  onChange: (next: Filters) => void
  onRefresh: () => void
  loading: boolean
}) {
  const [pendingFrom, setPendingFrom] = useState(filters.from)
  const [pendingTo, setPendingTo]     = useState(filters.to)

  function toggleSource(src: string) {
    const next = filters.sources.includes(src)
      ? filters.sources.filter(s => s !== src)
      : [...filters.sources, src]
    onChange({ ...filters, sources: next })
  }

  function switchToAbsolute() {
    const now   = new Date()
    const start = new Date(now.getTime() - filters.quickMinutes * 60 * 1000)
    const from  = toDatetimeLocal(start)
    const to    = toDatetimeLocal(now)
    setPendingFrom(from)
    setPendingTo(to)
    onChange({ ...filters, timeMode: 'absolute', from, to })
  }

  function applyAbsolute() {
    onChange({ ...filters, from: pendingFrom, to: pendingTo })
  }

  const isLive = filters.timeMode === 'quick'

  return (
    <div className="border-b border-border-subtle bg-bg-raised/50 divide-y divide-border-subtle/50">
      {/* Row 1: source + severity + ack */}
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Source pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-text-muted uppercase tracking-wide mr-0.5">Source</span>
          <button
            onClick={() => onChange({ ...filters, sources: [] })}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              filters.sources.length === 0
                ? 'bg-accent text-white border-accent'
                : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40'
            }`}
          >
            All
          </button>
          {ALL_SOURCES.map(src => (
            <button
              key={src}
              onClick={() => toggleSource(src)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                filters.sources.includes(src)
                  ? 'bg-accent/15 text-accent border-accent/40'
                  : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40'
              }`}
            >
              {src}
            </button>
          ))}
        </div>

        <div className="h-3 w-px bg-border-subtle hidden sm:block" />

        {/* Severity */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-text-muted uppercase tracking-wide">Severity</span>
          <div className="relative">
            <select
              value={filters.minSeverity}
              onChange={e => onChange({ ...filters, minSeverity: Number(e.target.value) })}
              className="appearance-none bg-bg-surface border border-border-subtle rounded px-2 py-0.5 pr-5 text-[11px] text-text-primary cursor-pointer hover:border-accent/40 transition-colors focus:outline-none focus:border-accent"
            >
              {SEV_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <ChevronDown size={10} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted" />
          </div>
        </div>

        {/* Ack status */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-text-muted uppercase tracking-wide">Status</span>
          <div className="relative">
            <select
              value={filters.ackFilter}
              onChange={e => onChange({ ...filters, ackFilter: e.target.value as AckFilter })}
              className="appearance-none bg-bg-surface border border-border-subtle rounded px-2 py-0.5 pr-5 text-[11px] text-text-primary cursor-pointer hover:border-accent/40 transition-colors focus:outline-none focus:border-accent"
            >
              {ACK_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <ChevronDown size={10} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted" />
          </div>
        </div>
      </div>

      {/* Row 2: time */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Live indicator */}
        {isLive && (
          <span className="flex items-center gap-1 text-[10px] text-status-success">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-success opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-status-success" />
            </span>
            Live
          </span>
        )}

        {/* Quick range pills */}
        {QUICK_RANGES.map(r => (
          <button
            key={r.minutes}
            onClick={() => onChange({ ...filters, timeMode: 'quick', quickMinutes: r.minutes })}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              isLive && filters.quickMinutes === r.minutes
                ? 'bg-accent text-white border-accent'
                : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40'
            }`}
          >
            Last {r.label}
          </button>
        ))}

        <div className="h-3 w-px bg-border-subtle" />

        {/* Absolute toggle */}
        {isLive ? (
          <button
            onClick={switchToAbsolute}
            className="px-2 py-0.5 rounded text-[11px] font-medium border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
          >
            Absolute
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-text-muted uppercase tracking-wide">From</span>
            <input
              type="datetime-local"
              value={pendingFrom}
              onChange={e => setPendingFrom(e.target.value)}
              className="bg-bg-surface border border-border-subtle rounded px-2 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent transition-colors"
            />
            <span className="text-[10px] text-text-muted">→</span>
            <input
              type="datetime-local"
              value={pendingTo}
              onChange={e => setPendingTo(e.target.value)}
              className="bg-bg-surface border border-border-subtle rounded px-2 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent transition-colors"
            />
            <button
              onClick={applyAbsolute}
              className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Apply
            </button>
            <button
              onClick={() => onChange({ ...filters, timeMode: 'quick' })}
              className="px-2 py-0.5 rounded text-[11px] font-medium border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
            >
              Live
            </button>
          </div>
        )}

        {/* Refresh button */}
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
          className="ml-auto p-1 rounded text-text-muted hover:text-text-primary transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertFeed({ initialAlerts, compact }: { initialAlerts?: any[]; compact?: boolean }) {
  const [filters, setFilters]   = useState<Filters>(DEFAULT_FILTERS)
  const [alerts, setAlerts]     = useState<any[]>(initialAlerts || [])
  const [loading, setLoading]   = useState(!initialAlerts)
  const [page, setPage]         = useState(1)
  const [total, setTotal]       = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [ackingAll, setAckingAll] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Fetch from API ──────────────────────────────────────────────────────────
  const fetchAlerts = useCallback(async (f: Filters, p: number, append = false) => {
    setLoading(true)
    try {
      const res = await fetch(buildQuery(f, p))
      if (!res.ok || !mountedRef.current) return
      const data = await res.json()
      if (!mountedRef.current) return
      setAlerts(prev => append ? [...prev, ...data.events] : data.events)
      setTotal(data.pagination?.total ?? 0)
    } catch {
      // ignore — leave previous results in place
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  // Fetch on mount (replace initialAlerts with filtered view)
  useEffect(() => {
    fetchAlerts(DEFAULT_FILTERS, 1)
  }, [fetchAlerts])

  // Re-fetch whenever filters change (not on page change — handled separately)
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
    setPage(1)
    setSelected([])
    fetchAlerts(filters, 1)
  }, [filters, fetchAlerts])

  // ── SSE live stream (quick mode only) ─────────────────────────────────────
  useEffect(() => {
    if (filters.timeMode !== 'quick') return

    const source = new EventSource('/api/monitoring/security/stream?channel=events')
    source.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data) as NotifyMessage
        if (frame.channel !== 'events' || !frame.payload?.id) return

        const res = await fetch(`/api/monitoring/security/alerts/${frame.payload.id}`)
        if (!res.ok || !mountedRef.current) return
        const { event: alertEvent } = await res.json()
        if (!alertEvent || !mountedRef.current) return
        if (!matchesFilters(alertEvent, filtersRef.current)) return

        setAlerts(prev => {
          if (prev.some((a: any) => a.id === alertEvent.id)) return prev
          return [alertEvent, ...prev].slice(0, 200)
        })
        setTotal(t => t + 1)
      } catch {
        // ignore malformed frames
      }
    }
    return () => source.close()
  }, [filters.timeMode])

  // ── Ack actions ───────────────────────────────────────────────────────────
  async function ackSelected() {
    if (selected.length === 0) return
    await fetch('/api/monitoring/security/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected }),
    })
    setAlerts(prev => prev.map((a: any) => selected.includes(a.id) ? { ...a, acknowledged: true } : a))
    setSelected([])
  }

  const ackAll = useCallback(async () => {
    setAckingAll(true)
    try {
      await fetch('/api/monitoring/security/alerts/ack-all', { method: 'POST' })
      setAlerts(prev => prev.map((a: any) => ({ ...a, acknowledged: true })))
      setSelected([])
    } finally {
      setAckingAll(false)
    }
  }, [])

  // ── Load more ─────────────────────────────────────────────────────────────
  function loadMore() {
    const nextPage = page + 1
    setPage(nextPage)
    fetchAlerts(filters, nextPage, true)
  }

  const hasMore = alerts.length < total

  // ── Render ────────────────────────────────────────────────────────────────
  const hasUnacked = alerts.some((a: any) => !a.acknowledged)

  return (
    <div>
      <FilterBar
        filters={filters}
        onChange={setFilters}
        onRefresh={() => fetchAlerts(filters, 1)}
        loading={loading}
      />

      {/* Action toolbar */}
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between bg-bg-raised min-h-[36px]">
        {selected.length > 0 ? (
          <>
            <span className="text-xs text-text-muted">{selected.length} selected</span>
            <button onClick={ackSelected} className="text-xs text-accent hover:underline">
              Acknowledge selected
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-text-muted">
              {loading ? (
                <span className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> Loading…</span>
              ) : (
                `${total} total · ${alerts.filter((a: any) => !a.acknowledged).length} unacknowledged`
              )}
            </span>
            {hasUnacked && (
              <button
                onClick={ackAll}
                disabled={ackingAll}
                className="flex items-center gap-1.5 text-xs text-text-secondary border border-border-subtle rounded px-2 py-1 hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
              >
                <CheckCheck size={11} />
                {ackingAll ? 'Clearing…' : 'Acknowledge All'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Alert list */}
      {!loading && alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Shield size={32} className="text-text-muted/40" />
          <p className="text-sm font-medium text-text-secondary">No alerts match the current filters</p>
          <p className="text-xs text-text-muted max-w-xs">
            Try widening the time range or adjusting the source and severity filters.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {alerts.map((alert: any) => {
            const Icon = SOURCE_ICONS[alert.source] || Shield
            return (
              <div
                key={alert.id}
                className={`px-4 py-3 flex items-start gap-3 transition-colors ${
                  selected.includes(alert.id) ? 'bg-accent/5' : 'hover:bg-bg-raised'
                } ${alert.acknowledged ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(alert.id)}
                  onChange={() => setSelected(prev =>
                    prev.includes(alert.id) ? prev.filter(id => id !== alert.id) : [...prev, alert.id]
                  )}
                  className="mt-1 accent-accent"
                />
                <Icon size={14} className={`flex-shrink-0 mt-0.5 ${SOURCE_COLORS[alert.source] || 'text-text-muted'}`} />
                <Link href={`/security/alerts/${alert.id}`} className="flex-1 min-w-0 group">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-text-primary truncate group-hover:text-accent transition-colors">
                      {alert.title}
                    </span>
                    <SeverityBadge severity={alert.severity} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-text-muted">{alert.source}</span>
                    <span className="text-[10px] text-text-muted">·</span>
                    <span className="text-[10px] text-text-muted">{new Date(alert.createdAt).toLocaleString()}</span>
                  </div>
                  {!compact && alert.description && (
                    <p className="text-xs text-text-muted mt-1 truncate">{alert.description}</p>
                  )}
                </Link>
              </div>
            )
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="px-4 py-3 border-t border-border-subtle flex items-center justify-between">
          <span className="text-xs text-text-muted">Showing {alerts.length} of {total}</span>
          <button
            onClick={loadMore}
            className="text-xs text-accent hover:underline"
          >
            Load more
          </button>
        </div>
      )}
      {loading && alerts.length > 0 && (
        <div className="px-4 py-3 flex justify-center">
          <Loader2 size={14} className="animate-spin text-text-muted" />
        </div>
      )}
    </div>
  )
}
