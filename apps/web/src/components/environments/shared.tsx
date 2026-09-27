'use client'

import { Server, Container, Globe, RefreshCw, X } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import type { BootstrapLog } from './types'

export const TYPE_ICONS: Record<string, React.ReactNode> = {
  cluster: <Server size={14} />,
  docker:  <Container size={14} />,
  remote:  <Globe size={14} />,
}

export const modalPanel = 'w-full bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl'

/** Title bar shared by the environment modals. */
export function ModalHeader({ title, onClose, icon }: { title: React.ReactNode; onClose?: () => void; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <h2 className="text-sm font-semibold text-text-primary truncate">{title}</h2>
      </div>
      {onClose && (
        <IconButton label="Close" onClick={onClose} className="shrink-0">
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-sm border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
      {children}
    </div>
  )
}

export function LoadingBlock() {
  return (
    <div className="text-center py-8 text-xs text-text-muted">
      <RefreshCw size={14} className="animate-spin mx-auto mb-2" />Loading…
    </div>
  )
}

export function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
      {children}
    </div>
  )
}

/** Streaming bootstrap/deploy log. */
export function BootstrapLogView({ logs, running, maxHeight = 'max-h-72' }: { logs: BootstrapLog[]; running: boolean; maxHeight?: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
      <div className={`${maxHeight} overflow-y-auto p-3 space-y-1 font-mono text-[11px]`} role="log" aria-live="polite">
        {logs.map((log, i) => (
          <div key={i} className={
            log.type === 'step'  ? 'text-accent font-semibold' :
            log.type === 'error' ? 'text-status-error' :
            log.type === 'done'  ? 'text-status-healthy font-semibold' :
            'text-text-muted'
          }>
            {log.type === 'step'  ? `▶ ${log.message}` :
             log.type === 'done'  ? `✓ ${log.message}` :
             log.type === 'error' ? `✗ ${log.message}` :
             `  ${log.message}`}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-1.5 text-text-muted">
            <RefreshCw size={10} className="animate-spin" /> Running…
          </div>
        )}
      </div>
    </div>
  )
}

export const isTerminalLog = (e: BootstrapLog) => e.type === 'done' || e.type === 'error'
export const errorLog = (message: string): BootstrapLog => ({ type: 'error', message })
