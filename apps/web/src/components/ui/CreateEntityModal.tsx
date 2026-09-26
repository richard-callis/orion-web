'use client'
import { useId } from 'react'
import { X } from 'lucide-react'
import { Dialog } from './Dialog'
import { Button, IconButton } from './Button'

interface Props {
  title: string
  subtitle?: string
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  submitting: boolean
  submitDisabled: boolean
  children: React.ReactNode
}

export function CreateEntityModal({
  title,
  subtitle,
  onClose,
  onSubmit,
  submitLabel,
  submitting,
  submitDisabled,
  children,
}: Props) {
  const titleId = useId()
  return (
    <Dialog
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={!submitting}
      overlayClassName="backdrop-blur-none p-0"
      className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="text-[10px] text-text-muted mt-0.5">{subtitle}</p>}
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="space-y-3">{children}</div>
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button size="md" onClick={onSubmit} disabled={submitDisabled || submitting}>
          {submitting ? 'Creating…' : submitLabel}
        </Button>
      </div>
    </Dialog>
  )
}
