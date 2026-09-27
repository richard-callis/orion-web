'use client'

import { forwardRef } from 'react'
import { cn } from './cn'

/** Shared field styling (inputs, selects, textareas). */
export const fieldClass =
  'w-full px-3 py-2 rounded border border-border-subtle bg-bg-raised text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-50 transition-colors'

/** Standard form-label styling (use with htmlFor). */
export const labelClass = 'block text-xs text-text-muted mb-1'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldClass, className)} {...props} />
})

export interface FieldProps {
  /** Visible label text. */
  label: React.ReactNode
  /** id of the control the label points at. */
  htmlFor: string
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/** Label + control + optional hint, with the label wired to the control. */
export function Field({ label, htmlFor, hint, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-xs text-text-muted">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  )
}
