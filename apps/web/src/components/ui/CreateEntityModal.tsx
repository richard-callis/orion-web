'use client'
import { X } from 'lucide-react'

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
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="text-[10px] text-text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={submitDisabled || submitting}
            className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
