'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Cpu, Filter, ChevronDown, ChevronUp, Zap, CheckCircle, AlertTriangle } from 'lucide-react'

interface EffectivenessEntry {
  name: string
  category: string // "skill" | "hook"
  fireRate: number
  successRate: string | number
  needsTuning: boolean
}

export default function EffectivenessPage() {
  const { id } = useParams() as { id: string }
  const [entries, setEntries] = useState<EffectivenessEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('')
  const [sortField, setSortField] = useState<'name' | 'fireRate' | 'successRate' | 'needsTuning'>('needsTuning')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const load = async () => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula/effectiveness`)
      const data = await res.json()
      setEntries(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000) // Auto-refresh every 30s
    return () => clearInterval(interval)
  }, [id])

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sorted = [...entries].sort((a, b) => {
    let cmp = 0
    if (sortField === 'name') cmp = a.name.localeCompare(b.name)
    else if (sortField === 'fireRate') cmp = Number(a.fireRate) - Number(b.fireRate)
    else if (sortField === 'successRate') cmp = Number(a.successRate) - Number(b.successRate)
    else if (sortField === 'needsTuning') cmp = (b.needsTuning ? 1 : 0) - (a.needsTuning ? 1 : 0)
    return sortDir === 'asc' ? cmp : -cmp
  })

  const filtered = sorted.filter(e => {
    if (filter && e.category !== filter) return false
    return true
  })

  const needsTuning = entries.filter(e => e.needsTuning).length
  const total = entries.length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Effectiveness</h1>
          <p className="text-xs text-text-muted ml-2">Monitor skill and hook performance</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-text-muted">
            {needsTuning}/{total} need tuning
          </span>
          <button
            onClick={load}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle flex-shrink-0">
        <Filter size={12} className="text-text-muted" />
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All Types</option>
          <option value="skill">Skills</option>
          <option value="hook">Hooks</option>
        </select>

        <div className="flex-1" />

        <div className="flex items-center gap-1 text-[10px] text-text-muted">
          Auto-refresh: 30s
        </div>
      </div>

      {/* Summary Cards */}
      {entries.length > 0 && (
        <div className="grid grid-cols-3 gap-3 px-4 pt-3 flex-shrink-0">
          <div className="rounded-lg border border-border-subtle bg-bg-surface p-3 text-center">
            <div className="text-lg font-semibold text-text-primary">{total}</div>
            <div className="text-[10px] text-text-muted">Total Instances</div>
          </div>
          <div className="rounded-lg border border-green-500/20 bg-bg-surface p-3 text-center">
            <div className="text-lg font-semibold text-green-400">{total - needsTuning}</div>
            <div className="text-[10px] text-text-muted">Healthy</div>
          </div>
          <div className="rounded-lg border border-red-500/20 bg-bg-surface p-3 text-center">
            <div className="text-lg font-semibold text-red-400">{needsTuning}</div>
            <div className="text-[10px] text-text-muted">Needs Tuning</div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="text-center py-8 text-text-muted text-sm">Loading effectiveness data...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">No data available yet.</div>
        ) : (
          <div className="border border-border-subtle rounded-lg overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-bg-raised border-b border-border-subtle">
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    <button onClick={() => toggleSort('name')} className="flex items-center gap-1 hover:text-text-primary">
                      Name {sortField === 'name' && (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                    </button>
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    <button onClick={() => toggleSort('fireRate')} className="flex items-center gap-1 hover:text-text-primary">
                      Fire Rate {sortField === 'fireRate' && (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                    </button>
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    <button onClick={() => toggleSort('successRate')} className="flex items-center gap-1 hover:text-text-primary">
                      Success Rate {sortField === 'successRate' && (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                    </button>
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    <button onClick={() => toggleSort('needsTuning')} className="flex items-center gap-1 hover:text-text-primary">
                      Status {sortField === 'needsTuning' && (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.map(entry => (
                  <tr
                    key={entry.name}
                    className={`transition-colors ${
                      entry.needsTuning ? 'bg-red-500/5' : ''
                    } hover:bg-bg-raised`}
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs text-text-primary">{entry.name}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        entry.category === 'skill'
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-orange-500/20 text-orange-400'
                      }`}>
                        {entry.category}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">
                      {entry.fireRate}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={
                        entry.needsTuning ? 'text-red-400' : 'text-green-400'
                      }>
                        {entry.successRate}%
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {entry.needsTuning ? (
                        <span className="flex items-center gap-1 text-red-400 text-[10px] font-medium">
                          <AlertTriangle size={11} />
                          Needs Tuning
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-green-400 text-[10px] font-medium">
                          <CheckCircle size={11} />
                          Healthy
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
