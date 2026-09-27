'use client'

import { forwardRef } from 'react'
import { cn } from './cn'
import { fieldClass } from './Input'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldClass, 'resize-none leading-relaxed', className)} {...props} />
})
