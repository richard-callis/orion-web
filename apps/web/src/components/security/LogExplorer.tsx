'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, ChevronDown, ChevronRight, Loader2, AlertCircle, Terminal } from 'lucide-react'

type LokiStream = {
  stream: Record<string, string>
  values: [string, string][]
}

type LokiResponse = {
  status: string
  data?: {
    resultType: string
    result: LokiStream[]
  }
  error?: string
}

type LogEntry = {
  ts: string
  tsNs: bigint
  labels: Record<string, string>
  raw: string
  parsed: Record<string, unknown> | null
}

const PRESETS: { label: string; ns: bigint }[] = [
  { label: '15m', ns: BigInt(15 * 60) * BigInt(1e9) },
  { label: '1h',  ns: BigInt(60 * 60) * BigInt(1e9) },
  { label: '6h',  ns: BigInt(6 * 60 * 60) * BigInt(1e9) },
  { label: '24h', ns: BigInt(24 * 60 * 60) * BigInt(1e9) },
  { label: '7d',  ns: BigInt(7 * 24 * 60 * 60) * BigInt(1e9) },
]

const LABEL_COLORS: Record<string, string> = {
  category: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  subtype:  'bg-purple-500/15 text-purple-400 border-purple-500/30',
  source:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
  host:     'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
}

function labelColor(key: string) {
  return LABEL_COLORS[key] ?? 'bg-bg-raised text-text-muted border-border-subtle'
}

function formatNs(ns: bigint): string {
  const ms = Number(ns / BigInt(1e6))
  const d = new Date(ms)
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) } catch { return null }
}

function flattenStreams(streams: LokiStream[]): LogEntry[] {
  const entries: LogEntry[] = []
  for (const stream of streams) {
    for (const [tsStr, raw] of stream.values) {
      const tsNs = BigInt(tsStr)
      entries.push({
        ts: formatNs(tsNs),
        tsNs,
        labels: stream.stream,
        raw,
        parsed: tryParseJson(raw),
      })
    }
  }
  entries.sort((a, b) => (a.tsNs < b.tsNs ? 1 : a.tsNs > b.tsNs ? -1 : 0))
  return entries
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const msg = entry.parsed?.raw as string | undefined ?? entry.raw

  const subtype = entry.labels.subtype ?? ''
  const isError = entry.parsed?.severity != null && Number(entry.parsed.severity) >= 50

  return (
    <div
      className={`border-b border-border-subtle last:border-0 ${isError ? 'bg-status-error/5' : ''}`}
    >
      <div
        className="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-bg-raised text-xs font-mono group"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-text-muted shrink-0 w-4 mt-0.5">
          {expanded
            ? <ChevronDown size={12} />
            : <ChevronRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          }
        </span>
        <span className="text-text-muted shrink-0 tabular-nums">{entry.ts}</span>
        <div className="flex flex-wrap gap-1 shrink-0">
          {Object.entries(entry.labels).map(([k, v]) => (
            <span key={k} className={`px-1.5 py-px rounded border text-[10px] font-medium ${labelColor(k)}`}>
              {k}=<span className="font-semibold">{v}</span>
            </span>
          ))}
        </div>
        <span className={`flex-1 truncate ${isError ? 'text-status-error' : 'text-text-secondary'}`}>
          {msg}
        </span>
      </div>
      {expanded && (
        <div className="px-9 pb-2 text-xs">
          <pre className="bg-bg-card rounded p-2 text-text-secondary overflow-auto max-h-48 text-[11px] leading-4">
            {entry.parsed
              ? JSON.stringify(entry.parsed, null, 2)
              : entry.raw}
          </pre>
        </div>
      )}
    </div>
  )
}

export default function LogExplorer() {
  const [query, setQuery] = useState('{category!=""}')
  const [presetIdx, setPresetIdx] = useState(1) // 1h default
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labels, setLabels] = useState<string[]>([])
  const [labelValues, setLabelValues] = useState<Record<string, string[]>>({})
  const [showLabelPicker, setShowLabelPicker] = useState(false)
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetch('/api/logs/labels')
      .then(r => r.json())
      .then(d => setLabels(d?.data ?? []))
      .catch(() => {})
  }, [])

  const fetchValues = useCallback(async (label: string) => {
    if (labelValues[label]) { setExpandedLabel(label); return }
    const r = await fetch(`/api/logs/label/${encodeURIComponent(label)}/values`)
    const d = await r.json()
    setLabelValues(prev => ({ ...prev, [label]: d?.data ?? [] }))
    setExpandedLabel(label)
  }, [labelValues])

  const injectFilter = useCallback((label: string, value: string) => {
    const filter = `${label}="${value}"`
    setQuery(prev => {
      const stripped = prev.replace(/^\{/, '').replace(/\}$/, '').trim()
      return stripped ? `{${stripped}, ${filter}}` : `{${filter}}`
    })
    setShowLabelPicker(false)
  }, [])

  const run = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)

    const nowNs = BigInt(Date.now()) * BigInt(1e6)
    const startNs = nowNs - PRESETS[presetIdx].ns
    const params = new URLSearchParams({
      query,
      start: startNs.toString(),
      end: nowNs.toString(),
      limit: '1000',
      direction: 'backward',
    })

    try {
      const res = await fetch(`/api/logs/query?${params}`, { signal: abortRef.current.signal })
      const data: LokiResponse = await res.json()
      if (data.error) { setError(data.error); setEntries([]); return }
      if (data.data?.resultType !== 'streams') { setError('Unexpected result type'); setEntries([]); return }
      setEntries(flattenStreams(data.data.result))
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setLoading(false)
    }
  }, [query, presetIdx])

  useEffect(() => { run() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-3">
      {/* Query bar */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex rounded-lg border border-border-visible overflow-hidden flex-1 min-w-0 bg-bg-raised">
          <span className="px-2 flex items-center border-r border-border-subtle text-text-muted">
            <Terminal size={13} />
          </span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="{category=&quot;auth&quot;} |= &quot;failed&quot;"
            className="flex-1 px-3 py-1.5 text-sm font-mono bg-transparent text-text-primary focus:outline-none placeholder:text-text-muted"
          />
        </div>

        {/* Time range */}
        <div className="flex gap-0.5 bg-bg-raised rounded-lg border border-border-subtle p-0.5">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPresetIdx(i)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                presetIdx === i ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Label picker toggle */}
        <div className="relative">
          <button
            onClick={() => setShowLabelPicker(s => !s)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border-subtle bg-bg-raised text-text-muted hover:text-text-primary transition-colors"
          >
            Labels
          </button>
          {showLabelPicker && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-bg-surface border border-border-visible rounded-lg shadow-lg w-56 overflow-auto max-h-72">
              {labels.length === 0
                ? <div className="px-3 py-2 text-xs text-text-muted">No labels yet</div>
                : labels.map(label => (
                  <div key={label}>
                    <button
                      onClick={() => fetchValues(label)}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-bg-raised text-text-secondary"
                    >
                      <span className="font-mono">{label}</span>
                      <ChevronRight size={12} className={`transition-transform ${expandedLabel === label ? 'rotate-90' : ''}`} />
                    </button>
                    {expandedLabel === label && (
                      <div className="pl-4 pb-1">
                        {(labelValues[label] ?? []).map(v => (
                          <button
                            key={v}
                            onClick={() => injectFilter(label, v)}
                            className="w-full text-left px-3 py-1 text-xs text-text-muted hover:text-accent hover:bg-bg-raised font-mono"
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              }
            </div>
          )}
        </div>

        <button
          onClick={run}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/80 disabled:opacity-60 transition-colors"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Run
        </button>
      </div>

      {/* Results */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
        {/* Status bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle text-xs text-text-muted bg-bg-raised">
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : error ? (
            <AlertCircle size={12} className="text-status-error" />
          ) : (
            <span className="w-3 h-3 rounded-full bg-status-success/70 inline-block" />
          )}
          {error
            ? <span className="text-status-error">{error}</span>
            : loading
              ? 'Running query…'
              : `${entries.length} log line${entries.length !== 1 ? 's' : ''} · last ${PRESETS[presetIdx].label}`
          }
        </div>

        {/* Log stream */}
        <div className="overflow-auto max-h-[60vh]">
          {entries.length === 0 && !loading && !error && (
            <div className="px-4 py-10 text-center text-sm text-text-muted">
              No logs matched the query for the selected time range.
            </div>
          )}
          {entries.map((entry, i) => (
            <LogRow key={`${entry.tsNs}-${i}`} entry={entry} />
          ))}
        </div>
      </div>
    </div>
  )
}
