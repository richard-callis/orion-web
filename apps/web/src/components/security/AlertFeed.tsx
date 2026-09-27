'use client'

import { useState, useEffect, useRef } from 'react'
import useSWRInfinite from 'swr/infinite'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { useEventSource } from '@/hooks/useSSE'
import {
  Loader2, Shield, Globe,
  Database, CheckCheck, ChevronDown, RefreshCw,
} from 'lucide-react'
import Link from 'next/link'
import { type NotifyMessage } from '@/lib/security/stream-utils'
import { SeverityBadge } from '@/components/ui/Badge'

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

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlertEvent {
  id: string
  title: string
  source: string
  severity: number
  acknowledged: boolean
  createdAt: string
  description?: string | null
}

interface AlertsPage { events: AlertEvent[]; pagination?: { total?: number } }

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

function matchesFilters(alert: AlertEvent, f: Filters): boolean {
  if (f.sources.length > 0 && !f.sources.includes(alert.source)) return false
  if (f.minSeverity > 0 && alert.severity < f.minSeverity) return false
  if (f.ackFilter === 'unacked' && alert.acknowledged) return false
  if (f.ackFilter === 'acked'   && !alert.acknowledged) return false
  return true
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
            aria-pressed={filters.sources.length === 0}
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
              aria-pressed={filters.sources.includes(src)}
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
              aria-label="Minimum severity"
              value={filters.minSeverity}
              onChange={e => onChange({ ...filters, minSeverity: Number(e.target.value) })}
              className="appearance-none bg-bg-surface border border-border-subtle rounded-sm px-2 py-0.5 pr-5 text-[11px] text-text-primary cursor-pointer hover:border-accent/40 transition-colors focus:outline-hidden focus:border-accent"
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
              aria-label="Acknowledgement status"
              value={filters.ackFilter}
              onChange={e => onChange({ ...filters, ackFilter: e.target.value as AckFilter })}
              className="appearance-none bg-bg-surface border border-border-subtle rounded-sm px-2 py-0.5 pr-5 text-[11px] text-text-primary cursor-pointer hover:border-accent/40 transition-colors focus:outline-hidden focus:border-accent"
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
            className="px-2 py-0.5 rounded-sm text-[11px] font-medium border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
          >
            Absolute
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-text-muted uppercase tracking-wide">From</span>
            <input
              type="datetime-local"
              aria-label="From"
              value={pendingFrom}
              onChange={e => setPendingFrom(e.target.value)}
              className="bg-bg-surface border border-border-subtle rounded-sm px-2 py-0.5 text-[11px] text-text-primary focus:outline-hidden focus:border-accent transition-colors"
            />
            <span className="text-[10px] text-text-muted">→</span>
            <input
              type="datetime-local"
              aria-label="To"
              value={pendingTo}
              onChange={e => setPendingTo(e.target.value)}
              className="bg-bg-surface border border-border-subtle rounded-sm px-2 py-0.5 text-[11px] text-text-primary focus:outline-hidden focus:border-accent transition-colors"
            />
            <button
              onClick={applyAbsolute}
              className="px-2.5 py-0.5 rounded-sm text-[11px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Apply
            </button>
            <button
              onClick={() => onChange({ ...filters, timeMode: 'quick' })}
              className="px-2 py-0.5 rounded-sm text-[11px] font-medium border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
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
          aria-label="Refresh alerts"
          className="ml-auto p-1 rounded-sm text-text-muted hover:text-text-primary transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function AlertFeed({ initialAlerts, compact }: { initialAlerts?: AlertEvent[]; compact?: boolean }) {
  const toast = useToast()
  const [filters, setFilters]   = useState<Filters>(DEFAULT_FILTERS)
  const [selected, setSelected] = useState<string[]>([])
  const [ackingAll, setAckingAll] = useState(false)
  // Alerts that arrived over SSE since the list was (re)loaded, newest first
  const [live, setLive]         = useState<AlertEvent[]>([])

  // Pages are keyed on the filters: a slow response for an old filter can't
  // overwrite the current one, and there's a single fetch on mount.
  const pagesQ = useSWRInfinite<AlertsPage>(
    (index, prev) => (prev && prev.events.length < PAGE_SIZE) ? null : buildQuery(filters, index + 1, PAGE_SIZE),
    {
      revalidateOnFocus: false,
      fallbackData: initialAlerts && filters === DEFAULT_FILTERS
        ? [{ events: initialAlerts, pagination: { total: initialAlerts.length } }]
        : undefined,
    },
  )
  const pages = pagesQ.data ?? []
  const loaded = pages.flatMap(p => p.events)
  const liveNew = live.filter(a => !loaded.some(l => l.id === a.id))
  const alerts = [...liveNew, ...loaded]
  const total = (pages[0]?.pagination?.total ?? 0) + liveNew.length
  const loading = pagesQ.isValidating

  // Reset selection and live buffer when the filters change
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
    setSelected([])
    setLive([])
  }, [filters])

  // ── SSE live stream (quick mode only) ─────────────────────────────────────
  useEventSource(
    filters.timeMode === 'quick' ? '/api/monitoring/security/stream?channel=events' : null,
    async (data) => {
      try {
        const frame = JSON.parse(data) as NotifyMessage
        if (frame.channel !== 'events' || !frame.payload?.id) return
        const { event: alertEvent } = await apiFetch<{ event?: AlertEvent }>(`/api/monitoring/security/alerts/${frame.payload.id}`)
        if (!alertEvent || !matchesFilters(alertEvent, filtersRef.current)) return
        setLive(prev => prev.some(a => a.id === alertEvent.id) ? prev : [alertEvent, ...prev].slice(0, 200))
      } catch {
        // ignore malformed frames / vanished events
      }
    },
  )

  const markAcked = (pred: (a: AlertEvent) => boolean) => {
    const ack = (a: AlertEvent) => pred(a) ? { ...a, acknowledged: true } : a
    setLive(prev => prev.map(ack))
    void pagesQ.mutate(ps => ps?.map(p => ({ ...p, events: p.events.map(ack) })), { revalidate: false })
  }

  // ── Ack actions ───────────────────────────────────────────────────────────
  async function ackSelected() {
    if (selected.length === 0) return
    const ids = selected
    try {
      await apiFetch('/api/monitoring/security/alerts/ack', { method: 'POST', body: { ids } })
      markAcked(a => ids.includes(a.id))
      setSelected([])
    } catch (e) {
      toast.error(`Failed to acknowledge: ${errorMessage(e)}`)
    }
  }

  async function ackAll() {
    setAckingAll(true)
    try {
      await apiFetch('/api/monitoring/security/alerts/ack-all', { method: 'POST' })
      markAcked(() => true)
      setSelected([])
    } catch (e) {
      toast.error(`Failed to acknowledge all: ${errorMessage(e)}`)
    } finally {
      setAckingAll(false)
    }
  }

  // ── Load more ─────────────────────────────────────────────────────────────
  const loadMore = () => { void pagesQ.setSize(pagesQ.size + 1) }
  const refresh = () => { setLive([]); void pagesQ.mutate() }

  const hasMore = loaded.length < (pages[0]?.pagination?.total ?? 0)

  // ── Render ────────────────────────────────────────────────────────────────
  const hasUnacked = alerts.some(a => !a.acknowledged)

  return (
    <div>
      <FilterBar
        filters={filters}
        onChange={setFilters}
        onRefresh={refresh}
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
                `${total} total · ${alerts.filter(a => !a.acknowledged).length} unacknowledged`
              )}
            </span>
            {hasUnacked && (
              <button
                onClick={ackAll}
                disabled={ackingAll}
                className="flex items-center gap-1.5 text-xs text-text-secondary border border-border-subtle rounded-sm px-2 py-1 hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
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
          {alerts.map(alert => {
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
                  aria-label={`Select ${alert.title}`}
                  checked={selected.includes(alert.id)}
                  onChange={() => setSelected(prev =>
                    prev.includes(alert.id) ? prev.filter(id => id !== alert.id) : [...prev, alert.id]
                  )}
                  className="mt-1 accent-accent"
                />
                <Icon size={14} className={`shrink-0 mt-0.5 ${SOURCE_COLORS[alert.source] || 'text-text-muted'}`} />
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
      {pagesQ.error && !pagesQ.data && (
        <p role="alert" className="px-4 py-3 text-xs text-status-error">Failed to load alerts: {errorMessage(pagesQ.error)}</p>
      )}

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
