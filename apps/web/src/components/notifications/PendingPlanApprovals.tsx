'use client'
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, XCircle, X, Loader2 } from 'lucide-react'

interface PendingTask {
  id: string
  title: string
  status: string
  metadata: Record<string, unknown> | null
}

const RISK_COLORS: Record<string, string> = {
  low: 'text-status-healthy',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-status-error',
}

/**
 * Surfaces tasks paused at plan-before-execute (status 'pending_validation'
 * with metadata.planApproved === false) as actionable notification cards.
 * Resume → /api/tasks/:id/resume-plan, Cancel → /api/tasks/:id/cancel.
 */
export function PendingPlanApprovals() {
  const [tasks, setTasks]         = useState<PendingTask[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [acting, setActing]       = useState<string | null>(null)

  const fetchPending = useCallback(async () => {
    try {
      const data: PendingTask[] = await fetch('/api/tasks?status=pending_validation').then(r => r.json())
      // Only show tasks that paused for plan approval (not those awaiting human
      // validation of completed work — those have no planRisk in metadata).
      setTasks(
        (Array.isArray(data) ? data : []).filter(t => {
          const meta = (t.metadata ?? {}) as Record<string, unknown>
          return meta.planApproved === false && meta.planRisk !== undefined
        })
      )
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchPending()
    const timer = setInterval(fetchPending, 15_000)
    return () => clearInterval(timer)
  }, [fetchPending])

  const resume = async (task: PendingTask) => {
    setActing(task.id)
    try {
      await fetch(`/api/tasks/${task.id}/resume-plan`, { method: 'POST' })
      setTasks(prev => prev.filter(t => t.id !== task.id))
    } finally { setActing(null) }
  }

  const cancel = async (task: PendingTask) => {
    setActing(task.id)
    try {
      await fetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
      setTasks(prev => prev.filter(t => t.id !== task.id))
    } finally { setActing(null) }
  }

  const dismiss = (id: string) => setDismissed(prev => new Set([...prev, id]))

  const visible = tasks.filter(t => !dismissed.has(t.id))
  if (visible.length === 0) return null

  return createPortal(
    <div className="fixed bottom-16 right-4 z-40 flex flex-col gap-2 items-end max-w-sm">
      {visible.map(task => {
        const meta = (task.metadata ?? {}) as Record<string, unknown>
        const risk = String(meta.planRisk ?? 'high')
        const riskColor = RISK_COLORS[risk] ?? 'text-orange-400'
        return (
          <div key={task.id}
            className="w-full rounded-xl border border-orange-500/40 bg-bg-sidebar shadow-2xl overflow-hidden animate-in slide-in-from-right-4 duration-200">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-orange-500/20 bg-orange-500/5">
              <Pause size={12} className="text-orange-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-orange-400 flex-1 truncate">Agent paused for approval</span>
              <button onClick={() => dismiss(task.id)} className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors">
                <X size={12} />
              </button>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5">
              <p className="text-sm font-medium text-text-primary">{task.title}</p>
              <p className="text-xs mt-0.5">
                Risk level: <span className={`font-semibold uppercase ${riskColor}`}>{risk}</span>
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle bg-bg-card">
              <button
                onClick={() => cancel(task)}
                disabled={acting === task.id}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50">
                <XCircle size={11} /> Cancel
              </button>
              <div className="flex-1" />
              <button
                onClick={() => resume(task)}
                disabled={acting === task.id}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                {acting === task.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Resume
              </button>
            </div>
          </div>
        )
      })}
    </div>,
    document.body
  )
}
