'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, GitBranch, Plus, Loader2, MessageSquare, Rocket, CheckCircle2 } from 'lucide-react'
import type { Epic, Feature } from '@/types/tasks'
import { PlanWithAIButton } from './PlanWithAIButton'
import { DetailPanelShell } from '../ui/DetailPanelShell'
import { useToast } from '../ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'

interface Props {
  epic: Epic
  onUpdate: (patch: Partial<Epic>) => Promise<void>
  onDelete: () => Promise<void>
  onPlanWithClaude: (modelId?: string) => void
  onNewFeature: () => void
  onSelectFeature: (f: Feature) => void
  onClose: () => void
}

export function EpicDetailPanel({ epic, onUpdate, onDelete, onPlanWithClaude, onNewFeature, onSelectFeature, onClose }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [title, setTitle]         = useState(epic.title)
  const [desc, setDesc]           = useState(epic.description ?? '')
  const [plan, setPlan]           = useState(epic.plan ?? '')
  const [status, setStatus]       = useState(epic.status)
  const [epicPlanningRoom, setEpicPlanningRoom] = useState<{ id: string } | null>(null)
  const [approving, setApproving]   = useState(false)
  const [justApproved, setJustApproved] = useState(false)

  // Features that have a plan + tasks but are not yet approved.
  const unapprovedFeatures = epic.features.filter(
    f => f.plan && !f.planApprovedAt && (f._count?.tasks ?? 0) > 0
  )

  const handleApproveAll = async () => {
    setApproving(true)
    try {
      await apiFetch(`/api/epics/${epic.id}/approve-plan`, { method: 'POST' })
      setJustApproved(true)
    } catch (e) {
      toast.error(`Failed to approve plans: ${errorMessage(e)}`)
    } finally {
      setApproving(false)
    }
  }

  useEffect(() => {
    setJustApproved(false)
    setTitle(epic.title)
    setDesc(epic.description ?? '')
    setPlan(epic.plan ?? '')
    setStatus(epic.status)
    setEpicPlanningRoom(null)

    let cancelled = false
    // Fetch fresh data — plan may have been saved from the chat screen
    apiFetch<Epic>(`/api/epics/${epic.id}`)
      .then(fresh => {
        if (cancelled || fresh.plan === epic.plan) return
        setPlan(fresh.plan ?? '')
        void onUpdate({ plan: fresh.plan ?? null })
      })
      .catch(() => { /* keep the data we were given */ })

    // Check if there is an existing planning room for this epic
    apiFetch<{ rooms?: Array<{ id: string }> }>(`/api/chatrooms?epicId=${epic.id}&type=planning`)
      .then(data => {
        if (!cancelled && data.rooms?.length) setEpicPlanningRoom({ id: data.rooms[0].id })
      })
      .catch(() => { /* no existing room */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when a different epic is shown
  }, [epic.id])

  const save = () => onUpdate({ title, description: desc || null, plan: plan || null, status })

  return (
    <DetailPanelShell
      onClose={onClose}
      header={<span className="text-xs font-semibold text-text-secondary">Epic</span>}
      footer={
        <>
          <PlanWithAIButton onSelect={onPlanWithClaude} />
          {epicPlanningRoom && (
            <button
              onClick={() => router.push(`/messages?r=${epicPlanningRoom.id}`)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-accent/40 text-accent text-sm hover:bg-accent/10 transition-colors"
            >
              <MessageSquare size={14} /> Continue Planning
            </button>
          )}
          {unapprovedFeatures.length > 0 && !justApproved && (
            <button
              onClick={handleApproveAll}
              disabled={approving}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-status-healthy/15 text-status-healthy border border-status-healthy/30 text-sm hover:bg-status-healthy/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {approving ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              Approve All Plans ({unapprovedFeatures.length})
            </button>
          )}
          {justApproved && (
            <p className="text-xs text-status-healthy text-center flex items-center justify-center gap-1.5">
              <CheckCircle2 size={13} /> Plans approved — agents will begin shortly
            </p>
          )}
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors"
          >
            <Trash2 size={14} /> Delete Epic
          </button>
        </>
      }
    >
      <div>
        <label htmlFor="epic-title" className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title</label>
        <input id="epic-title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={save}
          className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        />
      </div>

      <div>
        <label htmlFor="epic-status" className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Status</label>
        <select id="epic-status"
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
        <label htmlFor="epic-your-description" className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
        <textarea id="epic-your-description"
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onBlur={save}
          rows={4}
          placeholder="What is this epic about?"
          className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
        />
      </div>

      <div>
        <label htmlFor="epic-claude-s-plan" className="text-[10px] text-accent uppercase tracking-wide mb-1 block">Claude&apos;s Plan</label>
        <textarea id="epic-claude-s-plan"
          value={plan}
          onChange={e => setPlan(e.target.value)}
          onBlur={save}
          rows={6}
          placeholder="No plan yet — use 'Plan with Claude' to generate one..."
          className="w-full px-2.5 py-1.5 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-text-muted uppercase tracking-wide">Features ({epic.features.length})</span>
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
              {f.status === 'done'
                ? <CheckCircle2 size={11} className="text-status-healthy flex-shrink-0" />
                : f.planApprovedAt
                  ? <Rocket size={11} className="text-status-healthy flex-shrink-0" />
                  : null}
              <span className="text-[10px] text-text-muted">{f._count?.tasks ?? 0}</span>
            </div>
          ))}
          {epic.features.length === 0 && (
            <p className="text-[10px] text-text-muted py-2 text-center">No features yet</p>
          )}
        </div>
      </div>

      <p className="text-[10px] text-text-muted">Created {new Date(epic.createdAt).toLocaleDateString()}</p>
    </DetailPanelShell>
  )
}
