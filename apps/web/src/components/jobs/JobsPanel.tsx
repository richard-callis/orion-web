'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { BriefcaseIcon, X, RefreshCw, Trash2, Archive } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/Button'
import { RunStatusBadge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'

interface BackgroundJob {
  id: string
  type: string
  title: string
  status: string // queued | running | completed | failed
  logs: string[]
  environmentId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  archivedAt: string | null
}

// ── Time helpers ───────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function elapsed(start: string, end: string | null): string {
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

function isActive(status: string) {
  return status === 'running' || status === 'queued'
}

// ── Job detail modal ───────────────────────────────────────────────────────────

function JobModal({ jobId, onClose, onArchive, onDelete }: {
  jobId: string
  onClose: () => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
}) {
  // Poll every 2s while the job runs; stop once it reaches a terminal state.
  const { data: job } = useSWR<BackgroundJob>(`/api/jobs/${jobId}`, {
    refreshInterval: latest => (latest && !isActive(latest.status) ? 0 : 2000),
  })
  const [busy, setBusy]     = useState(false)
  const logEndRef           = useRef<HTMLDivElement>(null)
  const toast               = useToast()

  // Auto-scroll logs to bottom when new lines arrive
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [job?.logs])

  const handleArchive = async () => {
    if (!job) return
    setBusy(true)
    try {
      await apiFetch(`/api/jobs/${job.id}`, { method: 'PATCH', body: { archived: true } })
      onArchive(job.id)
      onClose()
    } catch (e) {
      toast.error(`Failed to archive job: ${errorMessage(e, 'unknown error')}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!job) return
    setBusy(true)
    try {
      await apiFetch(`/api/jobs/${job.id}`, { method: 'DELETE' })
      onDelete(job.id)
      onClose()
    } catch (e) {
      toast.error(`Failed to delete job: ${errorMessage(e, 'unknown error')}`)
    } finally {
      setBusy(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <Dialog
      onClose={onClose}
      label={job?.title ?? 'Background job'}
      className="bg-bg-card border border-border-subtle rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]"
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4 border-b border-border-subtle">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">
              {job?.title ?? 'Loading…'}
            </span>
            {job && <RunStatusBadge status={job.status} variant="inline" />}
          </div>
          {job && (
            <div className="flex items-center gap-3 mt-1 text-[10px] text-text-muted">
              <span>Started {relativeTime(job.createdAt)}</span>
              <span>Duration: {elapsed(job.createdAt, job.completedAt)}</span>
              {job.environmentId && <span>env: {job.environmentId.slice(0, 8)}</span>}
            </div>
          )}
        </div>
        <IconButton label="Close" onClick={onClose} className="flex-shrink-0">
          <X size={14} />
        </IconButton>
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-y-auto bg-bg-canvas p-4 font-mono text-[11px] text-text-secondary leading-relaxed min-h-32">
        {!job && (
          <div className="flex items-center gap-2 text-text-muted">
            <RefreshCw size={11} className="animate-spin" />
            <span>Loading…</span>
          </div>
        )}
        {job?.logs.map((line, i) => (
          <div
            key={i}
            className={
              line.includes('Bootstrap failed') || line.startsWith('Error:') ? 'text-status-error' :
              line.includes('✓') ? 'text-status-healthy' :
              line.includes('✗') || line.includes('⚠') ? 'text-status-warning' : ''
            }
          >
            {line}
          </div>
        ))}
        {job && (job.status === 'running' || job.status === 'queued') && (
          <div className="flex items-center gap-1.5 text-text-muted mt-1">
            <RefreshCw size={9} className="animate-spin" />
            <span>Running…</span>
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Footer */}
      {job && (
        <div className="flex items-center justify-between gap-2 p-3 border-t border-border-subtle">
          <div className="flex items-center gap-2">
            {(job.status === 'completed' || job.status === 'failed') && !job.archivedAt && (
              <button
                onClick={handleArchive}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors disabled:opacity-50"
              >
                <Archive size={11} />
                Archive
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-status-error/40 text-status-error hover:bg-status-error/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </Dialog>,
    document.body,
  )
}

// ── Jobs panel (header icon + dropdown) ───────────────────────────────────────

export function JobsPanel() {
  const [open, setOpen]           = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const panelRef                  = useRef<HTMLDivElement>(null)

  // Poll quickly only while something is running or the dropdown is open.
  // SWR pauses polling while the tab is hidden.
  const openRef = useRef(open)
  openRef.current = open
  const { data, mutate } = useSWR<BackgroundJob[]>('/api/jobs', {
    refreshInterval: latest =>
      openRef.current || (Array.isArray(latest) && latest.some(j => isActive(j.status))) ? 5000 : 15000,
  })
  const jobs = Array.isArray(data) ? data : []

  // Close dropdown when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeJobs = jobs.filter(j => isActive(j.status))
  const badgeCount = activeJobs.length

  const removeJob = (id: string) => {
    mutate(prev => prev?.filter(j => j.id !== id), { revalidate: false })
  }

  if (typeof document === 'undefined') return null

  return (
    <div className="relative" ref={panelRef}>
      {/* Icon button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
        title="Background jobs"
      >
        <BriefcaseIcon size={15} />
        {badgeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && createPortal(
        <div
          className="fixed z-50 bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl w-80 overflow-hidden"
          style={{
            '--top': (() => {
              const btn = panelRef.current?.querySelector('button')
              if (!btn) return '56px'
              const rect = btn.getBoundingClientRect()
              return `${rect.bottom + 8}px`
            })(),
            '--right': (() => {
              const btn = panelRef.current?.querySelector('button')
              if (!btn) return '16px'
              return `${window.innerWidth - btn.getBoundingClientRect().right}px`
            })(),
          } as React.CSSProperties}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-semibold text-text-primary">Background Jobs</span>
            {jobs.length > 0 && (
              <span className="text-[10px] text-text-muted">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-text-muted">No jobs yet</div>
            ) : (
              jobs.map(job => (
                <button
                  key={job.id}
                  onMouseDown={(e) => { e.stopPropagation(); setSelectedId(job.id); setOpen(false) }}
                  className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-bg-raised transition-colors text-left border-b border-border-subtle/50 last:border-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-primary font-medium truncate">{job.title}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <RunStatusBadge status={job.status} variant="inline" />
                      <span className="text-[10px] text-text-muted">{relativeTime(job.createdAt)}</span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Job detail modal */}
      {selectedId && (
        <JobModal
          jobId={selectedId}
          onClose={() => setSelectedId(null)}
          onArchive={removeJob}
          onDelete={removeJob}
        />
      )}
    </div>
  )
}
