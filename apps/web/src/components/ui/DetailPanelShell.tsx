'use client'
import { X } from 'lucide-react'

interface Props {
  header: React.ReactNode
  footer: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}

export function DetailPanelShell({ header, footer, onClose, children }: Props) {
  return (
    <aside className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-bg-sidebar shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div>{header}</div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
      <div className="p-3 border-t border-border-subtle space-y-2">{footer}</div>
    </aside>
  )
}
