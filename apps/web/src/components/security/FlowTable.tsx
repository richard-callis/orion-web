'use client'

import { useState, useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown, Search, Loader2, Settings } from 'lucide-react'

type FlowRow = {
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  protocol: string
  bytes: number
  packets: number
  duration: number
  timestamp: string
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

export default function FlowTable() {
  const [flows, setFlows] = useState<FlowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [sortCol, setSortCol] = useState<keyof FlowRow>('timestamp')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current = new AbortController()

    fetch('/api/monitoring/security/flows?limit=50', { signal: abortRef.current.signal })
      .then(r => {
        if (!r.ok) return r.json().then((d: any) => Promise.reject({ message: d.error || `Error ${r.status}`, code: d.code }))
        return r.json()
      })
      .then(d => { setFlows(d.flows || []); setLoading(false) })
      .catch((e: any) => {
        if (e?.name === 'AbortError') return
        setError(e?.message || 'Failed to load flows')
        setErrorCode(e?.code ?? null)
        setLoading(false)
      })

    return () => abortRef.current?.abort()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 text-center space-y-2">
        <p className="text-status-error text-sm">{error}</p>
        {errorCode === 'NO_GATEWAY' && (
          <p className="text-xs text-text-muted flex items-center justify-center gap-1">
            <Settings size={12} />
            ELK not configured — set up sources in the Settings tab
          </p>
        )}
      </div>
    )
  }

  if (flows.length === 0) {
    return (
      <div className="p-8 text-center text-text-muted text-sm">No flow records available.</div>
    )
  }

  const filtered = flows.filter(f => {
    if (!search) return true
    const q = search.toLowerCase()
    return Object.values(f).some(v => String(v).toLowerCase().includes(q))
  })

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortCol]
    const bVal = b[sortCol]
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal
    }
    return sortDir === 'asc'
      ? String(aVal).localeCompare(String(bVal))
      : String(bVal).localeCompare(String(aVal))
  })

  return (
    <div>
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search flows…"
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent"
            />
          </div>
          <span className="text-xs text-text-muted">{sorted.length} flows</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-subtle">
              {(['src_ip', 'dst_ip', 'protocol', 'bytes', 'packets', 'duration', 'timestamp'] as const).map(col => (
                <th
                  key={col}
                  className="px-4 py-2 text-left text-text-muted font-medium cursor-pointer hover:text-text-primary transition-colors whitespace-nowrap"
                  onClick={() => {
                    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                    else { setSortCol(col); setSortDir('asc') }
                  }}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.replace('_', ' ')}
                    {sortCol === col && (
                      sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {sorted.slice(0, 50).map((flow, i) => (
              <tr key={i} className="hover:bg-bg-raised transition-colors">
                <td className="px-4 py-2 font-mono text-text-primary">{flow.src_ip || '—'}</td>
                <td className="px-4 py-2 font-mono text-text-primary">{flow.dst_ip || '—'}</td>
                <td className="px-4 py-2 text-text-muted">{flow.protocol || '—'}</td>
                <td className="px-4 py-2 text-text-muted">{formatBytes(flow.bytes)}</td>
                <td className="px-4 py-2 text-text-muted">{flow.packets.toLocaleString()}</td>
                <td className="px-4 py-2 text-text-muted">{flow.duration}s</td>
                <td className="px-4 py-2 text-text-muted">{new Date(flow.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
