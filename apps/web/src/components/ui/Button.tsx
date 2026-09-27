'use client'

import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/80',
        secondary: 'border border-border-subtle bg-bg-raised text-text-primary hover:border-accent',
        ghost: 'text-text-muted hover:text-text-primary hover:bg-bg-raised',
        danger: 'bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25',
      },
      size: {
        xs: 'text-[10px] px-2 py-1',
        sm: 'text-xs px-3 py-1.5',
        md: 'text-sm px-4 py-2',
      },
    },
    defaultVariants: { variant: 'primary', size: 'sm' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required accessible name; also used as the tooltip. */
  label: string
}

/** Icon-only button. `label` is required so screen readers can announce it. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, type = 'button', title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        'p-1 rounded text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        className,
      )}
      {...props}
    />
  )
})
