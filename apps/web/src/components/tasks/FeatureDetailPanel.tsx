'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, Sparkles, Loader2, MessageSquare } from 'lucide-react'
import type { Feature } from '@/types/tasks'
import { PlanWithAIButton } from './PlanWithAIButton'
import { DetailPanelShell } from '../ui/DetailPanelShell'

interface Props {
  feature: Feature
  epicTitle: string
  onUpdate: (patch: Partial<Feature>) => Promise<void>
  onDelete: () => Promise<void>
  onPlanWithClaude: (modelId?: string) => void
  onGenerateTasks: () => Promise<void>
  onClose: () => void
}

export function FeatureDetailPanel({ feature, epicTitle, onUpdate, onDelete, onPlanWithClaude, onGenerateTasks, onClose }: Props) {
  const router = useRouter()
  const [title, setTitle]           = useState(feature.title)
  const [desc, setDesc]             = useState(feature.description ?? '')
  const [plan, setPlan]             = useState(feature.plan ?? '')
  const [status, setStatus]         = useState(feature.status)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError]     = useState<string | null>(null)
  const [creatingRoom, setCreatingRoom] = useState(false)

  useEffect(() => {
    setTitle(feature.title)
    setDesc(feature.description ?? '')
    setPlan(feature.plan ?? '')
    setStatus(feature.status)
    setGenError(null)
    // Fetch fresh data — plan may have been saved from the chat screen
    fetch(`/api/features/${feature.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh) return
        if (fresh.plan !== feature.plan) {
          setPlan(fresh.plan ?? '')
          onUpdate({ plan: fresh.plan ?? null }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [feature.id])

  const handlePlanFeature = async () => {
    setCreatingRoom(true)
    try {
      const r = await fetch('/api/chatrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `\u25b8 FEAT \u00b7 ${feature.title}`,
          type: 'planning',
          featureId: feature.id,
          planTarget: { type: 'feature', id: feature.id },
        }),
      })
      const room = await r.json()
      router.push(`/messages?r=${room.id}`)
    } catch { /* ignore */ }
    setCreatingRoom(false)
  }

  const save = () => onUpdate({ title, description: desc || null, plan: plan || null, status })

  const handleGenerate = async () => {
    setGenerating(true)
    setGenError(null)
    try {
      await onGenerateTasks()
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <DetailPanelShell
      onClose={onClose}
      header={
        <>
          <p className="text-[10px] text-text-muted">{epicTitle}</p>
          <span className="text-xs font-semibold text-text-secondary">Feature</span>
        </>
      }
      footer={
        <>
          <PlanWithAIButton onSelect={onPlanWithClaude} />
          <button
            onClick={handlePlanFeature}
            disabled={creatingRoom}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-accent/40 text-accent text-sm hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creatingRoom ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
            Plan Feature
          </button>
          {plan && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-accent/40 text-accent text-sm hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {generating ? 'Generating tasks...' : 'Generate Tasks from Plan'}
            </button>
          )}
          {genError && <p className="text-[10px] text-status-error text-center">{genError}</p>}
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors"
          >
            <Trash2 size={14} /> Delete Feature
          </button>
        </>
      }
    >
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
          placeholder="What does this feature deliver?"
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

      <div className="flex items-center gap-2 text-[10px] text-text-muted">
        <span>{feature._count?.tasks ?? 0} tasks</span>
        <span>·</span>
        <span>Created {new Date(feature.createdAt).toLocaleDateString()}</span>
      </div>
    </DetailPanelShell>
  )
}
