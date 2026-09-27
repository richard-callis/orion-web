'use client'

import { forwardRef } from 'react'
import { cn } from './cn'

/** Base classes shared by Input / Select / Textarea (the most common legacy `inputCls`). */
export const fieldClass =
  'w-full px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors disabled:opacity-50'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldClass, className)} {...props} />
})
