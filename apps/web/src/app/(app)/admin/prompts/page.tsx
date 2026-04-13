'use client'
import { useState, useEffect, useCallback } from 'react'
import { Save, RotateCcw, RefreshCw, ChevronDown, ChevronRight, Info } from 'lucide-react'

interface PromptVariable { name: string; description: string }

interface Prompt {
  key: string
  name: string
  description: string
  category: string
  content: string
  variables: PromptVariable[] | null
  isDefault: boolean
  updatedAt: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  system:    'System Prompts',
  bootstrap: 'Bootstrap Instructions',
  context:   'Initial Contexts',
}

const CATEGORY_ORDER = ['system', 'bootstrap', 'context']

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [resetting, setResetting] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/prompts')
      const data: Prompt[] = await res.json()
      setPrompts(data)
      // Initialize drafts from current content
      const d: Record<string, string> = {}
      for (const p of data) d[p.key] = p.content
      setDrafts(d)
      // Expand first item of each category by default
      const exp: Record<string, boolean> = {}
      const seen = new Set<string>()
      for (const p of data) {
        if (!seen.has(p.category)) { exp[p.key] = true; seen.add(p.category) }
      }
      setExpanded(exp)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async (key: string) => {
    setSaving(s => ({ ...s, [key]: true }))
    setErrors(e => ({ ...e, [key]: '' }))
    try {
      const res = await fetch(`/api/admin/prompts/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: drafts[key] }),
      })
      if (!res.ok) throw new Error('Save failed')
      setPrompts(ps => ps.map(p => p.key === key ? { ...p, content: drafts[key], isDefault: false } : p))
      setSaved(s => ({ ...s, [key]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [key]: false })), 2500)
    } catch (e) {
      setErrors(er => ({ ...er, [key]: e instanceof Error ? e.message : 'Save failed' }))
    } finally {
      setSaving(s => ({ ...s, [key]: false }))
    }
  }

  const handleReset = async (key: string) => {
    if (!confirm('Reset this prompt to the factory default?')) return
    setResetting(s => ({ ...s, [key]: true }))
    try {
      const res = await fetch(`/api/admin/prompts/${encodeURIComponent(key)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Reset failed')
      const data = await res.json() as { content: string }
      setDrafts(d => ({ ...d, [key]: data.content }))
      setPrompts(ps => ps.map(p => p.key === key ? { ...p, content: data.content, isDefault: true } : p))
    } catch (e) {
      setErrors(er => ({ ...er, [key]: e instanceof Error ? e.message : 'Reset failed' }))
    } finally {
      setResetting(s => ({ ...s, [key]: false }))
    }
  }

  const isDirty = (key: string) => {
    const p = prompts.find(x => x.key === key)
    return p && drafts[key] !== p.content
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-text-muted text-sm">
        <RefreshCw size={14} className="animate-spin" /> Loading prompts...
      </div>
    )
  }

  const byCategory = CATEGORY_ORDER.map(cat => ({
    cat,
    label: CATEGORY_LABELS[cat] ?? cat,
    items: prompts.filter(p => p.category === cat),
  })).filter(g => g.items.length > 0)

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Agent Prompts</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Edit the instructions sent to AI agents. Changes take effect within 60 seconds (cache TTL).
        </p>
      </div>

      {byCategory.map(({ cat, label, items }) => (
        <section key={cat} className="space-y-3">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">{label}</h2>
          <div className="space-y-2">
            {items.map(p => (
              <PromptCard
                key={p.key}
                prompt={p}
                draft={drafts[p.key] ?? p.content}
                dirty={!!isDirty(p.key)}
                saving={!!saving[p.key]}
                saved={!!saved[p.key]}
                resetting={!!resetting[p.key]}
                error={errors[p.key] ?? ''}
                expanded={!!expanded[p.key]}
                onToggle={() => setExpanded(e => ({ ...e, [p.key]: !e[p.key] }))}
                onChange={v => setDrafts(d => ({ ...d, [p.key]: v }))}
                onSave={() => handleSave(p.key)}
                onReset={() => handleReset(p.key)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function PromptCard({
  prompt, draft, dirty, saving, saved, resetting, error, expanded,
  onToggle, onChange, onSave, onReset,
}: {
  prompt: Prompt
  draft: string
  dirty: boolean
  saving: boolean
  saved: boolean
  resetting: boolean
  error: string
  expanded: boolean
  onToggle: () => void
  onChange: (v: string) => void
  onSave: () => void
  onReset: () => void
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-raised transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="text-text-muted flex-shrink-0" /> : <ChevronRight size={14} className="text-text-muted flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{prompt.name}</span>
            {!prompt.isDefault && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">modified</span>
            )}
            {dirty && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 font-medium">unsaved</span>
            )}
          </div>
          {!expanded && (
            <p className="text-xs text-text-muted truncate mt-0.5">{prompt.description}</p>
          )}
        </div>
        <span className="text-[10px] text-text-muted font-mono flex-shrink-0">{prompt.key}</span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border-subtle">
          {/* Description + variables */}
          <div className="px-4 py-3 bg-bg-raised border-b border-border-subtle">
            <div className="flex items-start gap-2">
              <Info size={13} className="text-text-muted flex-shrink-0 mt-0.5" />
              <p className="text-xs text-text-secondary">{prompt.description}</p>
            </div>
            {prompt.variables && prompt.variables.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {prompt.variables.map(v => (
                  <span key={v.name} className="inline-flex items-center gap-1 text-[11px] bg-bg-card border border-border-subtle rounded px-2 py-0.5" title={v.description}>
                    <code className="text-accent">{v.name}</code>
                    <span className="text-text-muted">— {v.description}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Editor */}
          <div className="px-4 py-3">
            <textarea
              value={draft}
              onChange={e => onChange(e.target.value)}
              rows={Math.min(30, Math.max(8, draft.split('\n').length + 2))}
              className="w-full px-3 py-2 text-xs font-mono bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors resize-y"
              spellCheck={false}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="mx-4 mb-3 rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}

          {/* Footer actions */}
          <div className="px-4 py-3 border-t border-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={onSave}
                disabled={saving || !dirty}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors disabled:opacity-40"
              >
                {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="text-xs text-status-healthy">Saved</span>}
            </div>
            {!prompt.isDefault && (
              <button
                onClick={onReset}
                disabled={resetting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border-subtle text-text-muted text-xs hover:text-text-primary hover:border-border-visible transition-colors disabled:opacity-40"
              >
                {resetting ? <RefreshCw size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
