'use client'

import { useId, useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2, ChevronRight } from 'lucide-react'
import { apiFetch, ApiError } from '@/lib/api'
import { IconButton } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'

export type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7
export const STEPS = ['Token', 'Admin', 'Git', 'Domain', 'AI', 'Vault', 'Monitoring']

/** Setup field look (slightly rounder than the app default). */
export const setupFieldClass = 'rounded-lg'

/** Remember the step to resume at after a reload. */
export function rememberStep(step: Step) {
  try { sessionStorage.setItem('orion_setup_step', String(step)) } catch { /* storage unavailable */ }
}

export type SetupResult<T> = { ok: true; data: T } | { ok: false; error: string; body: Record<string, unknown> | null }

/**
 * POST to a setup endpoint. Never throws: network errors and non-2xx both come
 * back as `{ ok: false }` with the server's `error` (or `fallback`).
 */
export async function postSetup<T = Record<string, unknown>>(url: string, body: Record<string, unknown> = {}, fallback = 'Request failed'): Promise<SetupResult<T>> {
  try {
    return { ok: true, data: await apiFetch<T>(url, { method: 'POST', body }) }
  } catch (e) {
    const b = e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body as Record<string, unknown> : null
    const error = typeof b?.error === 'string' ? b.error : e instanceof ApiError ? fallback : `${fallback}: ${e instanceof Error ? e.message : String(e)}`
    return { ok: false, error, body: b }
  }
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 text-xs text-status-error bg-status-error/10 border border-status-error/20 rounded-lg px-3 py-2.5">
      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}

/** Label + control + optional hint, with the label bound to the control via id. */
export function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: (id: string) => React.ReactNode }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-muted mb-1.5">{label}</label>
      {children(id)}
      {hint && <p className="text-[11px] text-text-muted mt-1">{hint}</p>}
    </div>
  )
}

export const Required = () => <span className="text-status-error" aria-hidden>*</span>

export function PrimaryButton({ loading, loadingLabel, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; loadingLabel?: string }) {
  return (
    <button
      {...props}
      className={cn('w-full flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors', className)}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  )
}

export const ContinueLabel = () => <>Continue <ChevronRight size={14} /></>

export function SkipButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="flex-1 py-2 text-sm text-text-muted border border-border-subtle rounded-lg hover:border-text-muted transition-colors disabled:opacity-60"
    >
      Skip for now
    </button>
  )
}

export function StepHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">{title}</h2>
      {children && <p className="text-xs text-text-muted">{children}</p>}
    </div>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={copy} className="flex-shrink-0">
      {copied ? <Check size={12} className="text-status-success" /> : <Copy size={12} />}
    </IconButton>
  )
}

export function ProgressBar({ current }: { current: Step }) {
  return (
    <ol className="flex items-center gap-0 mb-8" aria-label="Setup progress">
      {STEPS.map((label, i) => {
        const stepNum = (i + 1) as Step
        const done = stepNum < current
        const active = stepNum === current
        return (
          <li key={label} className="flex items-center" aria-current={active ? 'step' : undefined}>
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors
                ${done ? 'bg-accent text-white' : active ? 'border-2 border-accent text-accent' : 'border border-border-subtle text-text-muted'}`}>
                {done ? <Check size={12} aria-label="done" /> : stepNum}
              </div>
              <span className={`text-[10px] font-medium ${active ? 'text-text-primary' : 'text-text-muted'}`}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`h-px w-6 mx-1 mb-4 transition-colors ${done ? 'bg-accent' : 'bg-border-subtle'}`} aria-hidden />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** Selectable card with a radio input (git provider / monitoring options). */
export function RadioCard({ name, checked, onChange, className, children }: { name: string; checked: boolean; onChange: () => void; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn(
      'flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors',
      checked ? 'border-accent bg-accent/5' : 'border-border-subtle hover:border-text-muted',
      className,
    )}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="accent-accent flex-shrink-0" />
      {children}
    </label>
  )
}
