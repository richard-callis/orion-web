'use client'
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Coins } from 'lucide-react'

interface PendingTask {
  id: string
  title: string
  status: string
  metadata: Record<string, unknown> | null
}

/**
 * Surfaces tasks that have been paused by the token budget gate
 * (status 'pending_validation' with metadata.budgetExceeded === true).
 *
 * These tasks resume automatically when the daily/monthly budget resets
 * or when the agent's budget limit is increased by an admin.
 * The "Dismiss" button removes the card locally without changing task state.
 */
export function BudgetPausedTasks() {
  const [tasks, setTasks]         = useState<PendingTask[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const fetchPending = useCallback(async () => {
    try {
      const data: PendingTask[] = await fetch('/api/tasks?status=pending_validation').then(r => r.json())
      setTasks(
        (Array.isArray(data) ? data : []).filter(t => {
          const meta = (t.metadata ?? {}) as Record<string, unknown>
          return meta.budgetExceeded === true
        })
      )
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchPending()
    const timer = setInterval(fetchPending, 30_000)
    return () => clearInterval(timer)
  }, [fetchPending])

  const dismiss = (id: string) => setDismissed(prev => new Set([...prev, id]))

  const visible = tasks.filter(t => !dismissed.has(t.id))
  if (visible.length === 0) return null

  return createPortal(
    <div className="fixed bottom-16 right-4 z-39 flex flex-col gap-2 items-end max-w-sm w-full">
      {visible.map(task => {
        const meta   = (task.metadata ?? {}) as Record<string, unknown>
        const reason = (meta.budgetReason as string | undefined) ?? 'Token budget exceeded'

        return (
          <div
            key={task.id}
            className="w-full rounded-xl border border-yellow-500/40 bg-bg-sidebar shadow-2xl overflow-hidden animate-in slide-in-from-right-4 duration-200">

            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-yellow-500/40 bg-yellow-500/5">
              <Coins size={12} className="text-yellow-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-yellow-400 flex-1 truncate">Token budget exceeded</span>
              <button
                onClick={() => dismiss(task.id)}
                className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors">
                <X size={12} />
              </button>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5 space-y-1.5">
              <p className="text-sm font-medium text-text-primary leading-snug">{task.title}</p>
              <p className="text-xs text-text-muted leading-relaxed">{reason}</p>
              <p className="text-[11px] text-text-muted">
                Task will resume automatically when the budget resets or the agent&apos;s limit is increased.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end px-3 py-2 border-t border-border-subtle bg-bg-card">
              <button
                onClick={() => dismiss(task.id)}
                className="px-2.5 py-1.5 rounded text-xs font-medium text-text-muted border border-border-subtle hover:bg-bg-raised transition-colors">
                Dismiss
              </button>
            </div>

          </div>
        )
      })}
    </div>,
    document.body
  )
}
