'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { BriefcaseIcon, X, RefreshCw, CheckCircle, XCircle, Clock, Trash2, Archive } from 'lucide-react'

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

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="flex items-center gap-1 text-status-healthy text-[10px] font-medium">
        <CheckCircle size={11} />
        done
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1 text-status-error text-[10px] font-medium">
        <XCircle size={11} />
        failed
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1 text-status-warning text-[10px] font-medium">
        <RefreshCw size={11} className="animate-spin" />
        running
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-text-muted text-[10px] font-medium">
      <Clock size={11} />
      queued
    </span>
  )
}

// ── Job detail modal ───────────────────────────────────────────────────────────

function JobModal({ jobId, onClose, onArchive, onDelete }: {
  jobId: string
  onClose: () => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [job, setJob]       = useState<BackgroundJob | null>(null)
  const [busy, setBusy]     = useState(false)
  const logEndRef           = useRef<HTMLDivElement>(null)
  const isActiveRef         = useRef(true)

  const fetchJob = useCallback(async () => {
    try {
      const data: BackgroundJob = await fetch(`/api/jobs/${jobId}`).then(r => r.json())
      if (!isActiveRef.current) return
      setJob(data)
    } catch { /* silent */ }
  }, [jobId])

  useEffect(() => {
    isActiveRef.current = true
    fetchJob()

    const interval = setInterval(async () => {
      if (!isActiveRef.current) return
      const data: BackgroundJob = await fetch(`/api/jobs/${jobId}`).then(r => r.json()).catch(() => null)
      if (!isActiveRef.current || !data) return
      setJob(data)
      // Stop polling once terminal
      if (data.status === 'completed' || data.status === 'failed') {
        clearInterval(interval)
      }
    }, 2000)

    return () => {
      isActiveRef.current = false
      clearInterval(interval)
    }
  }, [fetchJob, jobId])

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
      await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      onArchive(job.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!job) return
    setBusy(true)
    try {
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })
      onDelete(job.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-card border border-border-subtle rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-start gap-3 p-4 border-b border-border-subtle">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text-primary">
                {job?.title ?? 'Loading…'}
              </span>
              {job && <StatusBadge status={job.status} />}
            </div>
            {job && (
              <div className="flex items-center gap-3 mt-1 text-[10px] text-text-muted">
                <span>Started {relativeTime(job.createdAt)}</span>
                <span>Duration: {elapsed(job.createdAt, job.completedAt)}</span>
                {job.environmentId && <span>env: {job.environmentId.slice(0, 8)}</span>}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary p-1 rounded transition-colors flex-shrink-0"
          >
            <X size={14} />
          </button>
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
      </div>
    </div>,
    document.body,
  )
}

// ── Jobs panel (header icon + dropdown) ───────────────────────────────────────

export function JobsPanel() {
  const [jobs, setJobs]           = useState<BackgroundJob[]>([])
  const [open, setOpen]           = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const panelRef                  = useRef<HTMLDivElement>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const res  = await fetch('/api/jobs')
      if (!res.ok) return
      const data: unknown = await res.json()
      if (Array.isArray(data)) setJobs(data as BackgroundJob[])
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchJobs()
    const interval = setInterval(fetchJobs, 5000)
    return () => clearInterval(interval)
  }, [fetchJobs])

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

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const badgeCount = activeJobs.length

  const handleArchive = (id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id))
  }

  const handleDelete = (id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id))
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
                      <StatusBadge status={job.status} />
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
          onArchive={handleArchive}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
