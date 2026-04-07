'use client'
import { useState, useEffect } from 'react'
import { X, Trash2, GitBranch, Plus, Sparkles, Loader2 } from 'lucide-react'
import type { Epic, Feature } from '@/types/tasks'
import { PlanWithAIButton } from './PlanWithAIButton'

interface Props {
  epic: Epic
  onUpdate: (patch: Partial<Epic>) => Promise<void>
  onDelete: () => Promise<void>
  onPlanWithClaude: (modelId?: string) => void
  onGenerateFeatures: () => Promise<void>
  onNewFeature: () => void
  onSelectFeature: (f: Feature) => void
  onClose: () => void
}

export function EpicDetailPanel({ epic, onUpdate, onDelete, onPlanWithClaude, onGenerateFeatures, onNewFeature, onSelectFeature, onClose }: Props) {
  const [title, setTitle]         = useState(epic.title)
  const [desc, setDesc]           = useState(epic.description ?? '')
  const [plan, setPlan]           = useState(epic.plan ?? '')
  const [status, setStatus]       = useState(epic.status)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError]   = useState<string | null>(null)

  useEffect(() => {
    setTitle(epic.title)
    setDesc(epic.description ?? '')
    setPlan(epic.plan ?? '')
    setStatus(epic.status)
    setGenError(null)
    // Fetch fresh data — plan may have been saved from the chat screen
    fetch(`/api/epics/${epic.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh) return
        if (fresh.plan !== epic.plan) {
          setPlan(fresh.plan ?? '')
          onUpdate({ plan: fresh.plan ?? null }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [epic.id])

  const save = () => onUpdate({ title, description: desc || null, plan: plan || null, status })

  const handleGenerate = async () => {
    setGenerating(true)
    setGenError(null)
    try {
      await onGenerateFeatures()
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <aside className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-bg-sidebar shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-xs font-semibold text-text-secondary">Epic</span>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={save}
            className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Status</label>
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); onUpdate({ status: e.target.value }) }}
            className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
          >
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            onBlur={save}
            rows={4}
            placeholder="What is this epic about?"
            className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
          />
        </div>

        <div>
          <label className="text-[10px] text-accent uppercase tracking-wide mb-1 block">Claude&apos;s Plan</label>
          <textarea
            value={plan}
            onChange={e => setPlan(e.target.value)}
            onBlur={save}
            rows={6}
            placeholder="No plan yet — use 'Plan with Claude' to generate one..."
            className="w-full px-2.5 py-1.5 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
          />
        </div>

        {/* Features list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Features ({epic.features.length})</label>
            <button onClick={onNewFeature} className="flex items-center gap-1 text-[10px] text-accent hover:text-accent/80">
              <Plus size={10} /> Add
            </button>
          </div>
          <div className="space-y-1">
            {epic.features.map(f => (
              <div
                key={f.id}
                onClick={() => onSelectFeature(f)}
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-border-subtle bg-bg-raised hover:border-accent/40 cursor-pointer transition-colors"
              >
                <GitBranch size={11} className="text-text-muted flex-shrink-0" />
                <span className="text-xs text-text-primary flex-1 truncate">{f.title}</span>
                <span className="text-[10px] text-text-muted">{f._count?.tasks ?? 0}</span>
              </div>
            ))}
            {epic.features.length === 0 && (
              <p className="text-[10px] text-text-muted py-2 text-center">No features yet</p>
            )}
          </div>
        </div>

        <p className="text-[10px] text-text-muted">Created {new Date(epic.createdAt).toLocaleDateString()}</p>
      </div>

      <div className="p-3 border-t border-border-subtle space-y-2">
        <PlanWithAIButton onSelect={onPlanWithClaude} />
        {plan && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-accent/40 text-accent text-sm hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generating ? 'Generating features...' : 'Generate Features from Plan'}
          </button>
        )}
        {genError && <p className="text-[10px] text-status-error text-center">{genError}</p>}
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors"
        >
          <Trash2 size={14} /> Delete Epic
        </button>
      </div>
    </aside>
  )
}
