'use client'
import { useState } from 'react'
import { Search, RefreshCw, Pin, FileText } from 'lucide-react'

interface KnowledgeSearchHit {
  noteId: string
  title: string
  type: string
  folder: string
  pinned: boolean
  snippet: string
  score: number
  vectorScore: number | null
  keywordScore: number | null
}

const inputCls = 'w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'

function ScorePill({ label, value, decimals = 3 }: { label: string; value: number | null; decimals?: number }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-raised border border-border-subtle text-[10px] text-text-muted">
      {label} <span className="text-text-primary font-mono">{value != null ? value.toFixed(decimals) : '—'}</span>
    </span>
  )
}

export default function KnowledgeSearchPage() {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelRef, setModelRef] = useState<string | null>(null)
  const [results, setResults] = useState<KnowledgeSearchHit[] | null>(null)

  const runSearch = async () => {
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/knowledge-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, limit }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? `Request failed (${res.status})`)
        setResults(null)
        return
      }
      setModelRef(json.modelRef)
      setResults(json.results)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResults(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Search size={18} className="text-accent" /> Knowledge Search
        </h1>
        <p className="text-sm text-text-muted mt-0.5">
          Run an ad-hoc hybrid query against the Note knowledge base — the same search
          used for agent RAG context — and see exactly what pops up, with the vector
          (semantic) and keyword (full-text) score behind each result exposed for
          debugging retrieval quality.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
          placeholder='Query, e.g. "CrashLoopBackOff pod-7f9" or how does the executor authenticate'
          className={inputCls}
          autoFocus
        />
        <input
          type="number"
          min={1}
          max={50}
          value={limit}
          onChange={e => setLimit(Math.min(Math.max(parseInt(e.target.value, 10) || 10, 1), 50))}
          className={`${inputCls} w-20 flex-shrink-0`}
          title="Top-K results"
        />
        <button
          onClick={runSearch}
          disabled={loading || !query.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {loading ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />} Search
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-sm rounded border border-red-500/30 bg-red-500/10 text-red-400">
          {error}
        </div>
      )}

      {results && (
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            {results.length} result{results.length === 1 ? '' : 's'}
            {' — '}embedding model: <span className="text-text-primary font-mono">{modelRef ?? 'none (keyword-only fallback)'}</span>
          </p>

          {results.length === 0 && (
            <div className="text-sm text-text-muted px-3 py-6 text-center border border-dashed border-border-subtle rounded">
              No notes matched this query.
            </div>
          )}

          {results.map(r => (
            <div key={r.noteId} className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 min-w-0">
                  {r.pinned && <Pin size={12} className="text-accent flex-shrink-0" />}
                  <FileText size={12} className="text-text-muted flex-shrink-0" />
                  <span className="text-sm font-medium text-text-primary truncate">{r.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted flex-shrink-0">{r.type}</span>
                  <span className="text-[10px] text-text-muted flex-shrink-0">{r.folder}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <ScorePill label="fused" value={r.score} decimals={5} />
                  <ScorePill label="vector" value={r.vectorScore} />
                  <ScorePill label="keyword" value={r.keywordScore} />
                </div>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap">{r.snippet}{r.snippet.length >= 300 ? '…' : ''}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
