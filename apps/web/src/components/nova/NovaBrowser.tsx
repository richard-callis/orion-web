'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Search, Bot, Server, ArrowRight, CheckCircle, XCircle, X } from 'lucide-react'
import type { Nova, NovaCategory } from '@/lib/nebula'

export interface NovaImportResult {
  novaName: string
  message: string
  prUrl?: string
  prNumber?: number
}

interface Props {
  onImport?: (result: NovaImportResult) => void
  onClose?: () => void
}

interface Env { id: string; name: string; type: string }

const CATEGORY_COLORS: Record<NovaCategory, string> = {
  Identity: 'bg-blue-500/20 text-blue-400',
  Storage: 'bg-purple-500/20 text-purple-400',
  Monitoring: 'bg-green-500/20 text-green-400',
  DevTools: 'bg-yellow-500/20 text-yellow-400',
  Agent: 'bg-cyan-500/20 text-cyan-400',
  Other: 'bg-gray-500/20 text-gray-400',
}

// ── Toast notification ─────────────────────────────────────────────────────────

export interface ToastState {
  message: string
  type: 'success' | 'error'
  prUrl?: string
}

interface ToastProps extends ToastState {
  onDismiss: () => void
}

export function Toast({ message, type, prUrl, onDismiss }: ToastProps) {
  useEffect(() => {
    if (type !== 'error') {
      const t = setTimeout(onDismiss, 8_000)
      return () => clearTimeout(t)
    }
  }, [type, onDismiss])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 right-6 z-[60] w-80 rounded-xl border shadow-2xl p-4 flex gap-3
        ${type === 'error' ? 'bg-bg-card border-status-error/40' : 'bg-bg-card border-accent/40'}`}
    >
      {type === 'error'
        ? <XCircle    size={18} className="text-status-error shrink-0 mt-0.5" />
        : <CheckCircle size={18} className="text-accent shrink-0 mt-0.5" />
      }
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${type === 'error' ? 'text-status-error' : 'text-accent'}`}>
          {type === 'error' ? 'Nova install failed' : 'Nova installed'}
        </p>
        <p className="text-xs text-text-muted mt-1 leading-snug">{message}</p>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-accent hover:underline mt-1.5"
          >
            View GitOps PR &rarr;
          </a>
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss notification" className="text-text-muted hover:text-text-primary shrink-0 p-0.5">
        <X size={13} />
      </button>
    </div>,
    document.body,
  )
}

export function NovaBrowser({ onImport, onClose }: Props) {
  const [novae, setNovae] = useState<Nova[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('')
  const [importing, setImporting] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)
  const [environments, setEnvironments] = useState<Env[]>([])
  const [envByNova, setEnvByNova] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<ToastState | null>(null)
  const importTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismissToast = useCallback(() => setToast(null), [])

  // Clear any pending "import complete" timeout if this component unmounts
  // (e.g. the user manually closes the panel) before it fires.
  useEffect(() => {
    return () => {
      if (importTimeoutRef.current) clearTimeout(importTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    fetch('/api/novas')
      .then(r => r.json())
      .then(data => {
        setNovae(data.novae || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
    fetch('/api/environments')
      .then(r => r.json())
      .then(data => setEnvironments(Array.isArray(data) ? data : []))
      .catch(() => setEnvironments([]))
  }, [])

  const handleImport = async (nova: Nova) => {
    if (importing || imported) return
    const isContent = nova.config?.type === 'content'
    const environmentId = envByNova[nova.id]
    if (isContent && !environmentId) return
    setImporting(nova.id)
    setToast(null)
    try {
      const res = await fetch(`/api/novas/${nova.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: nova.displayName,
          agentRole: nova.config?.type === 'agent' ? nova.description : undefined,
          ...(isContent ? { environmentId } : {}),
        }),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string
        message?: string
        prUrl?: string
        prNumber?: number
      }
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setImported(nova.id)
      const result: NovaImportResult = {
        novaName: nova.name,
        message: data.message || `Nova "${nova.displayName}" imported successfully.`,
        prUrl: data.prUrl,
        prNumber: data.prNumber,
      }
      // Briefly show the "Imported!" state on the button, then hand the
      // result up to the parent, which owns displaying the success toast
      // (this component — and any toast it rendered — unmounts once the
      // parent closes the panel in response to onImport).
      importTimeoutRef.current = setTimeout(() => {
        onImport?.(result)
        setImported(null)
        importTimeoutRef.current = null
      }, 700)
    } catch (err) {
      console.error('Import failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      setToast({ message, type: 'error' })
      setImported(null)
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
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          prUrl={toast.prUrl}
          onDismiss={dismissToast}
        />
      )}
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
              {nova.config?.type === 'content' && (
                <div className="mt-2">
                  <select
                    value={envByNova[nova.id] || ''}
                    onChange={e => setEnvByNova(prev => ({ ...prev, [nova.id]: e.target.value }))}
                    className="w-full px-2 py-1 text-[10px] rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
                  >
                    <option value="">Select environment…</option>
                    {environments.map(e => <option key={e.id} value={e.id}>{e.name} ({e.type})</option>)}
                  </select>
                </div>
              )}
              <div className="mt-2">
                <button
                  onClick={() => handleImport(nova)}
                  disabled={importing === nova.id || imported === nova.id || (nova.config?.type === 'content' && !envByNova[nova.id])}
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
