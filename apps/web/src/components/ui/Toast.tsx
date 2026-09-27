'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from './cn'

type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const DURATION_MS: Record<ToastKind, number> = { success: 4000, info: 4000, error: 7000 }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
  }, [])

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++
    setToasts(prev => [...prev.slice(-4), { id, kind, message }])
    timers.current.set(id, setTimeout(() => dismiss(id), DURATION_MS[kind]))
  }, [dismiss])

  useEffect(() => {
    const map = timers.current
    return () => { map.forEach(clearTimeout); map.clear() }
  }, [])

  const api = useRef<ToastApi>({
    show,
    success: m => show(m, 'success'),
    error: m => show(m, 'error'),
    info: m => show(m, 'info'),
  }).current

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-60 flex flex-col gap-2 w-[min(360px,calc(100vw-2rem))] pointer-events-none"
        aria-live="polite"
        role="status"
      >
        {toasts.map(t => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : undefined}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs shadow-2xl bg-bg-card',
              t.kind === 'error' && 'border-red-500/40 text-red-300',
              t.kind === 'success' && 'border-status-healthy/40 text-text-primary',
              t.kind === 'info' && 'border-border-visible text-text-primary',
            )}
          >
            {t.kind === 'error' && <AlertCircle size={14} className="text-red-400 shrink-0 mt-px" aria-hidden="true" />}
            {t.kind === 'success' && <CheckCircle2 size={14} className="text-status-healthy shrink-0 mt-px" aria-hidden="true" />}
            {t.kind === 'info' && <Info size={14} className="text-accent shrink-0 mt-px" aria-hidden="true" />}
            <span className="flex-1 wrap-break-word">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-text-muted hover:text-text-primary shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const noop = () => {}
const fallback: ToastApi = { show: noop, success: noop, error: noop, info: noop }

/** Show transient notifications. Safe to call outside the provider (no-op). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? fallback
}
