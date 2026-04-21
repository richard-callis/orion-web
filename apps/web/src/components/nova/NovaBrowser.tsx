'use client'
import { useState, useEffect } from 'react'
import { Search, Bot, Server, ArrowRight } from 'lucide-react'
import type { Nova, NovaCategory } from '@/lib/nebula'

interface Props {
  onImport?: (novaName: string) => void
  onClose?: () => void
}

const CATEGORY_COLORS: Record<NovaCategory, string> = {
  Identity: 'bg-blue-500/20 text-blue-400',
  Storage: 'bg-purple-500/20 text-purple-400',
  Monitoring: 'bg-green-500/20 text-green-400',
  DevTools: 'bg-yellow-500/20 text-yellow-400',
  Agent: 'bg-cyan-500/20 text-cyan-400',
  Other: 'bg-gray-500/20 text-gray-400',
}

export function NovaBrowser({ onImport, onClose }: Props) {
  const [novae, setNovae] = useState<Nova[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('')
  const [importing, setImporting] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/novas')
      .then(r => r.json())
      .then(data => {
        setNovae(data.novae || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleImport = async (nova: Nova) => {
    if (importing || imported) return
    setImporting(nova.id)
    try {
      const res = await fetch(`/api/novas/${nova.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: nova.displayName,
          agentRole: nova.config?.type === 'agent' ? nova.description : undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setImported(nova.id)
      onImport?.(nova.name)
      setTimeout(() => setImported(null), 3000)
    } catch (err) {
      console.error('Import failed:', err)
    } finally {
      setImporting(null)
    }
  }

  const filtered = novae.filter(n => {
    if (category && n.category !== category) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        n.name.toLowerCase().includes(q) ||
        n.displayName.toLowerCase().includes(q) ||
        (n.description && n.description.toLowerCase().includes(q))
      )
    }
    return true
  })

  const categories = Array.from(new Set(novae.map(n => n.category))) as NovaCategory[]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <Search size={14} className="text-text-muted" />
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search Nova definitions..."
          className="flex-1 px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
        />
        {onClose && (
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Category filter */}
      <div className="px-4 py-2 border-b border-border-subtle flex gap-1.5 flex-wrap flex-shrink-0">
        <button
          onClick={() => setCategory('')}
          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
            !category
              ? 'bg-accent/20 text-accent'
              : 'bg-bg-raised text-text-muted hover:text-text-primary'
          }`}
        >
          All
        </button>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(category === cat ? '' : cat)}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              category === cat
                ? 'bg-accent/20 text-accent'
                : `bg-bg-raised ${CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other}`
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Nova list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-center py-8 text-text-muted text-xs">Loading Nova catalog...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-xs">No Nova definitions found.</div>
        ) : (
          filtered.map(nova => (
            <div
              key={nova.id}
              className="rounded-lg border border-border-subtle bg-bg-raised p-3 hover:border-accent/40 transition-colors"
            >
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5">
                  {nova.config?.type === 'agent' ? (
                    <Bot size={14} className="text-accent" />
                  ) : (
                    <Server size={14} className="text-accent" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-text-primary truncate">{nova.displayName}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${CATEGORY_COLORS[nova.category] || CATEGORY_COLORS.Other}`}>
                      {nova.category}
                    </span>
                    <span className="text-[10px] text-text-muted">{nova.source}</span>
                  </div>
                  {nova.description && (
                    <p className="text-[10px] text-text-muted mt-1 line-clamp-2">{nova.description}</p>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {nova.tags?.slice(0, 3).map(tag => (
                      <span key={tag} className="text-[9px] text-text-muted bg-bg-raised px-1.5 py-0.5 rounded">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-2">
                <button
                  onClick={() => handleImport(nova)}
                  disabled={importing === nova.id || imported === nova.id}
                  className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                    imported === nova.id
                      ? 'bg-green-500/20 text-green-400'
                      : importing === nova.id
                      ? 'bg-accent/20 text-accent animate-pulse'
                      : 'bg-accent/15 text-accent hover:bg-accent/25'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {imported === nova.id ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                      Imported!
                    </>
                  ) : importing === nova.id ? (
                    'Importing...'
                  ) : (
                    <>
                      Import
                      <ArrowRight size={10} />
                    </>
                  )}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
