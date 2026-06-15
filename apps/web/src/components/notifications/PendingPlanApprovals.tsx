'use client'
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, XCircle, X, Loader2, ChevronDown, ChevronUp, ShieldAlert, ShieldOff } from 'lucide-react'

interface PendingTask {
  id: string
  title: string
  status: string
  metadata: Record<string, unknown> | null
}

const RISK_COLORS: Record<string, string> = {
  low:      'text-status-healthy',
  medium:   'text-yellow-400',
  high:     'text-orange-400',
  critical: 'text-status-error',
}

const RISK_BORDER: Record<string, string> = {
  low:      'border-status-healthy/40',
  medium:   'border-yellow-500/40',
  high:     'border-orange-500/40',
  critical: 'border-status-error/40',
}

/**
 * Surfaces tasks paused at plan-before-execute (status 'pending_validation'
 * with metadata.planApproved === false) as actionable notification cards.
 *
 * Supports partial plan approval: each plan step can be individually blocked
 * before resuming. Blocked steps are skipped by the agent when it resumes.
 */
export function PendingPlanApprovals() {
  const [tasks, setTasks]         = useState<PendingTask[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [acting, setActing]       = useState<string | null>(null)
  const [actionError, setActionError] = useState<Record<string, string>>({})
  // Per-task: set of step indices the human has blocked
  const [blockedSteps, setBlockedSteps] = useState<Record<string, Set<number>>>({})
  // Per-task: whether the steps panel is expanded
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?status=pending_validation')
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data: PendingTask[] = await res.json()
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

  const toggleStep = (taskId: string, stepIdx: number) => {
    setBlockedSteps(prev => {
      const current = new Set(prev[taskId] ?? [])
      if (current.has(stepIdx)) current.delete(stepIdx)
      else current.add(stepIdx)
      return { ...prev, [taskId]: current }
    })
  }

  const toggleExpanded = (taskId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const resume = async (task: PendingTask) => {
    setActing(task.id)
    setActionError(prev => ({ ...prev, [task.id]: '' }))
    const blocked = [...(blockedSteps[task.id] ?? [])]
    try {
      const r = await fetch(`/api/tasks/${task.id}/resume-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockedSteps: blocked }),
      })
      if (r.ok) setTasks(prev => prev.filter(t => t.id !== task.id))
      else setActionError(prev => ({ ...prev, [task.id]: 'Failed to resume task' }))
    } catch { setActionError(prev => ({ ...prev, [task.id]: 'Network error' })) }
    finally { setActing(null) }
  }

  const cancel = async (task: PendingTask) => {
    setActing(task.id)
    setActionError(prev => ({ ...prev, [task.id]: '' }))
    try {
      const r = await fetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
      if (r.ok) setTasks(prev => prev.filter(t => t.id !== task.id))
      else setActionError(prev => ({ ...prev, [task.id]: 'Failed to cancel task' }))
    } catch { setActionError(prev => ({ ...prev, [task.id]: 'Network error' })) }
    finally { setActing(null) }
  }

  const dismiss = (id: string) => setDismissed(prev => new Set([...prev, id]))

  const visible = tasks.filter(t => !dismissed.has(t.id))
  if (visible.length === 0) return null

  return createPortal(
    <div className="fixed bottom-16 right-4 z-40 flex flex-col gap-2 items-end max-w-sm w-full">
      {visible.map(task => {
        const meta    = (task.metadata ?? {}) as Record<string, unknown>
        const risk    = String(meta.planRisk ?? 'high')
        const steps   = (meta.planSteps as string[] | undefined) ?? []
        const summary = (meta.planContent as string | undefined)?.slice(0, 200) ?? ''
        const riskColor  = RISK_COLORS[risk]  ?? 'text-orange-400'
        const riskBorder = RISK_BORDER[risk]  ?? 'border-orange-500/40'
        const blocked    = blockedSteps[task.id] ?? new Set<number>()
        const isExpanded = expanded.has(task.id)
        const blockedCount = blocked.size
        const isActing = acting === task.id

        return (
          <div key={task.id}
            className={`w-full rounded-xl border ${riskBorder} bg-bg-sidebar shadow-2xl overflow-hidden animate-in slide-in-from-right-4 duration-200`}>

            {/* Header */}
            <div className={`flex items-center gap-2 px-3 py-2 border-b ${riskBorder} bg-orange-500/5`}>
              <Pause size={12} className={`${riskColor} flex-shrink-0`} />
              <span className={`text-xs font-semibold ${riskColor} flex-1 truncate`}>Agent paused for approval</span>
              <button onClick={() => dismiss(task.id)} className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors">
                <X size={12} />
              </button>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5 space-y-1.5">
              <p className="text-sm font-medium text-text-primary leading-snug">{task.title}</p>
              <p className="text-xs text-text-muted">
                Risk: <span className={`font-semibold uppercase ${riskColor}`}>{risk}</span>
                {steps.length > 0 && (
                  <span className="ml-2 text-text-muted">· {steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                )}
                {blockedCount > 0 && (
                  <span className="ml-1 text-status-error font-medium">· {blockedCount} blocked</span>
                )}
              </p>
              {summary && !isExpanded && (
                <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{summary}</p>
              )}
            </div>

            {/* Steps panel — toggle */}
            {steps.length > 0 && (
              <>
                <button
                  onClick={() => toggleExpanded(task.id)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-muted hover:text-text-primary border-t border-border-subtle bg-bg-card/50 transition-colors">
                  <span>{isExpanded ? 'Hide steps' : 'Review steps'}</span>
                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>

                {isExpanded && (
                  <div className="border-t border-border-subtle bg-bg-raised divide-y divide-border-subtle">
                    <p className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wide">
                      Toggle steps to block — blocked steps will be skipped
                    </p>
                    {steps.map((step, i) => {
                      const isBlocked = blocked.has(i)
                      return (
                        <button
                          key={i}
                          onClick={() => toggleStep(task.id, i)}
                          className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-sidebar
                            ${isBlocked ? 'bg-status-error/5' : ''}`}>
                          <div className="mt-0.5 flex-shrink-0">
                            {isBlocked
                              ? <ShieldOff size={12} className="text-status-error" />
                              : <ShieldAlert size={12} className="text-status-healthy" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={`text-[11px] leading-relaxed ${isBlocked ? 'line-through text-text-muted' : 'text-text-primary'}`}>
                              <span className="font-mono text-text-muted mr-1">{i + 1}.</span>
                              {step}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* Error */}
            {actionError[task.id] && (
              <p className="px-3 py-1.5 text-xs text-status-error bg-status-error/10 border-t border-status-error/20">
                {actionError[task.id]}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle bg-bg-card">
              <button
                onClick={() => cancel(task)}
                disabled={isActing}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50">
                <XCircle size={11} /> Cancel
              </button>
              <div className="flex-1" />
              {blockedCount > 0 && (
                <span className="text-[10px] text-status-error">{blockedCount} step{blockedCount !== 1 ? 's' : ''} blocked</span>
              )}
              <button
                onClick={() => resume(task)}
                disabled={isActing}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                {isActing ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                {blockedCount > 0 ? 'Approve (partial)' : 'Approve & Resume'}
              </button>
            </div>

          </div>
        )
      })}
    </div>,
    document.body
  )
}
