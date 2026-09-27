'use client'

import { forwardRef } from 'react'
import { cn } from './cn'
import { fieldClass } from './Input'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn(fieldClass, className)} {...props} />
})
