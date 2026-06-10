'use client'
import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle, Loader2, RefreshCw } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DriftFinding {
  resource:  string
  namespace: string
  kind:      string
  field:     string
  desired:   string
  actual:    string
  severity:  'low' | 'medium' | 'high'
}

interface DriftReport {
  id:            string
  environmentId: string
  status:        string // clean | drifted | error
  driftCount:    number
  scannedAt:     string
  findings:      DriftFinding[]
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  environmentId: string
  /** Optional: auto-refresh interval in milliseconds (default: no auto-refresh) */
  refreshInterval?: number
}

export function DriftStatusBadge({ environmentId, refreshInterval }: Props) {
  const [report, setReport]       = useState<DriftReport | null>(null)
  const [loading, setLoading]     = useState(true)
  const [scanning, setScanning]   = useState(false)
  const [popover, setPopover]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const popoverRef                = useRef<HTMLDivElement>(null)

  async function fetchLatest() {
    try {
      const res  = await fetch(`/api/environments/${environmentId}/drift`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { reports: DriftReport[] }
      setReport(data.reports[0] ?? null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function triggerScan() {
    setScanning(true)
    try {
      const res  = await fetch(`/api/environments/${environmentId}/drift`, { method: 'POST' })
      const data = await res.json() as { report?: DriftReport; error?: string }
      if (data.report) setReport(data.report)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    fetchLatest()
    if (refreshInterval) {
      const id = setInterval(fetchLatest, refreshInterval)
      return () => clearInterval(id)
    }
  }, [environmentId, refreshInterval]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close popover on outside click
  useEffect(() => {
    if (!popover) return
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopover(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [popover])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Drift…
      </span>
    )
  }

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-error">
        <AlertTriangle size={12} />
        Drift: unavailable
      </span>
    )
  }

  const hasDrift     = report?.status === 'drifted'
  const isError      = report?.status === 'error'
  const highCount    = report?.findings.filter(f => f.severity === 'high').length  ?? 0
  const medCount     = report?.findings.filter(f => f.severity === 'medium').length ?? 0
  const total        = report?.driftCount ?? 0
  const worstLabel   = highCount > 0 ? 'high' : medCount > 0 ? 'medium' : 'low'

  const badgeClass = hasDrift
    ? highCount > 0
      ? 'text-status-error border-status-error/30 bg-status-error/10'
      : 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10'
    : isError
      ? 'text-text-muted border-border bg-surface-raised'
      : 'text-status-healthy border-status-healthy/30 bg-status-healthy/10'

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setPopover(p => !p)}
        className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 ${badgeClass}`}
        title="Click to see drift details"
      >
        {hasDrift ? (
          <AlertTriangle size={12} />
        ) : isError ? (
          <AlertTriangle size={12} />
        ) : (
          <CheckCircle size={12} />
        )}

        {hasDrift
          ? `Drift: ${total} resource${total !== 1 ? 's' : ''} (${worstLabel})`
          : isError
            ? 'Drift: scan error'
            : 'Drift: Clean'}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); triggerScan() }}
          className="ml-0.5 opacity-60 hover:opacity-100"
          title="Trigger drift scan now"
          disabled={scanning}
        >
          <RefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
        </button>
      </button>

      {popover && (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded border border-border bg-surface-raised p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary">Drift Report</span>
            {report?.scannedAt && (
              <span className="text-[10px] text-text-muted">
                {new Date(report.scannedAt).toLocaleString()}
              </span>
            )}
          </div>

          {!report || report.status === 'clean' ? (
            <p className="text-xs text-status-healthy">No drift detected — cluster is in sync.</p>
          ) : report.status === 'error' ? (
            <p className="text-xs text-text-muted">Scan encountered an error. Check drift logs.</p>
          ) : (
            <div className="space-y-1.5">
              {report.findings.length === 0 ? (
                <p className="text-xs text-text-muted">Findings data unavailable.</p>
              ) : (
                report.findings.slice(0, 10).map((f, i) => (
                  <div key={i} className="rounded bg-surface-base px-2 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-text-primary truncate">
                        {f.kind}/{f.resource}
                        {f.namespace && f.namespace !== 'argocd' ? ` (${f.namespace})` : ''}
                      </span>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
                        f.severity === 'high'
                          ? 'bg-status-error/20 text-status-error'
                          : f.severity === 'medium'
                            ? 'bg-yellow-400/20 text-yellow-400'
                            : 'bg-text-muted/20 text-text-muted'
                      }`}>
                        {f.severity}
                      </span>
                    </div>
                    <div className="mt-0.5 text-text-muted">
                      <span className="text-text-secondary">{f.field}</span>
                      {': desired '}
                      <span className="text-status-healthy">{f.desired}</span>
                      {', actual '}
                      <span className="text-status-error">{f.actual}</span>
                    </div>
                  </div>
                ))
              )}
              {report.findings.length > 10 && (
                <p className="text-[11px] text-text-muted">
                  …and {report.findings.length - 10} more findings
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
