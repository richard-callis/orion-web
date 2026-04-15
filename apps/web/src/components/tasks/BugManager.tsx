'use client'
import { useState, useEffect, useRef } from 'react'
import { Plus, X, Trash2, ChevronRight, User } from 'lucide-react'
import type { Bug, TaskUser } from '@/types/tasks'

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_COLUMNS = ['open', 'triaged', 'in_progress', 'resolved', 'closed'] as const
type BugStatus = typeof STATUS_COLUMNS[number]

const statusLabel: Record<BugStatus, string> = {
  open:        'Open',
  triaged:     'Triaged',
  in_progress: 'In Progress',
  resolved:    'Resolved',
  closed:      'Closed',
}
const statusTopBorder: Record<BugStatus, string> = {
  open:        'border-t-status-error',
  triaged:     'border-t-status-warning',
  in_progress: 'border-t-accent',
  resolved:    'border-t-status-healthy',
  closed:      'border-t-border-visible',
}

const severityConfig: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  critical: { label: 'Critical', color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/30',    dot: 'bg-red-400'    },
  high:     { label: 'High',     color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/30', dot: 'bg-orange-400' },
  medium:   { label: 'Medium',   color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/30', dot: 'bg-yellow-400' },
  low:      { label: 'Low',      color: 'text-text-muted', bg: 'bg-bg-raised border-border-subtle',   dot: 'bg-border-visible' },
}

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  initialBugs: Bug[]
  users: Array<{ id: string; name: string | null; username: string }>
}

interface CreateBugForm {
  title: string
  description: string
  severity: string
  area: string
}

export function BugManager({ initialBugs, users }: Props) {
  const [bugs, setBugs]         = useState<Bug[]>(initialBugs)
  const [selectedBug, setSelectedBug] = useState<Bug | null>(null)
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)
  const [modal, setModal]       = useState(false)
  const [saving, setSaving]     = useState(false)
  const [form, setForm]         = useState<CreateBugForm>({ title: '', description: '', severity: 'medium', area: '' })

  // Detail edit state
  const [editTitle, setEditTitle]       = useState('')
  const [editDesc,  setEditDesc]        = useState('')
  const [editArea,  setEditArea]        = useState('')
  const [editSev,   setEditSev]         = useState('medium')
  const [editStatus, setEditStatus]     = useState<BugStatus>('open')
  const [editAssignee, setEditAssignee] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (selectedBug) {
      setEditTitle(selectedBug.title)
      setEditDesc(selectedBug.description ?? '')
      setEditArea(selectedBug.area ?? '')
      setEditSev(selectedBug.severity)
      setEditStatus(selectedBug.status as BugStatus)
      setEditAssignee(selectedBug.assignedUserId ?? '')
    } else {
      setEditTitle('')
      setEditDesc('')
      setEditArea('')
      setEditSev('medium')
      setEditStatus('open')
      setEditAssignee('')
    }
  }, [selectedBug?.id])

  const byStatus = (s: BugStatus) => bugs.filter(b => b.status === s)

  const updateBug = async (id: string, patch: Partial<Bug>) => {
    setBugs(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b))
    if (selectedBug?.id === id) setSelectedBug(s => s ? { ...s, ...patch } : s)
    await fetch(`/api/bugs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteBug = async (id: string) => {
    setBugs(prev => prev.filter(b => b.id !== id))
    if (selectedBug?.id === id) {
      setSelectedBug(null)
      setIsDetailModalOpen(false)
    }
    await fetch(`/api/bugs/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const createBug = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    const r = await fetch('/api/bugs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:       form.title,
        description: form.description || null,
        severity:    form.severity,
        area:        form.area || null,
        reportedBy:  'admin',
      }),
    })
    const bug: Bug = await r.json()
    setBugs(prev => [bug, ...prev])
    setForm({ title: '', description: '', severity: 'medium', area: '' })
    setModal(false)
    setSaving(false)
    setSelectedBug(bug)
    setIsDetailModalOpen(true)
  }

  const saveDetail = async () => {
    if (!selectedBug) return
    const assignedUser = users.find(u => u.id === editAssignee) ?? null
    const patch: Partial<Bug> = {
      title:          editTitle,
      description:    editDesc || null,
      area:           editArea || null,
      severity:       editSev,
      status:         editStatus,
      assignedUserId: editAssignee || null,
      assignedUser:   assignedUser ? {
        id: assignedUser.id, name: assignedUser.name, username: assignedUser.username, email: '', role: '',
      } as TaskUser : null,
    }
    await updateBug(selectedBug.id, patch)
  }

  const openCount = bugs.filter(b => b.status !== 'closed' && b.status !== 'resolved').length

  return (
    <div className="flex-1 flex overflow-hidden">

      {/* ── Kanban columns ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-4 lg:py-6">

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-text-primary">Bug Tracker</h2>
            {openCount > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-status-error/15 text-status-error border border-status-error/30">
                {openCount} open
              </span>
            )}
          </div>
          <button
            onClick={() => setModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors"
          >
            <Plus size={13} /> Report Bug
          </button>
        </div>

        {/* Columns */}
        <div className="flex gap-3 overflow-x-auto overflow-y-hidden flex-1">
          {STATUS_COLUMNS.map(col => {
            const colBugs = byStatus(col)
            return (
              <div key={col} className={`flex-shrink-0 w-52 flex flex-col rounded-lg border border-border-subtle border-t-2 ${statusTopBorder[col]} bg-bg-sidebar overflow-hidden`}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
                  <span className="text-xs font-medium text-text-secondary">{statusLabel[col]}</span>
                  <span className="text-[10px] text-text-muted">{colBugs.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colBugs.map(bug => {
                    const sev = severityConfig[bug.severity] ?? severityConfig.medium
                    const isSelected = selectedBug?.id === bug.id
                    return (
                      <div
                        key={bug.id}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedBug(null)
                            setIsDetailModalOpen(false)
                          } else {
                            setSelectedBug(bug)
                            setIsDetailModalOpen(true)
                          }
                        }}
                        className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${
                          isSelected
                            ? 'border-accent bg-accent/10'
                            : 'border-border-subtle bg-bg-raised hover:border-border-visible'
                        }`}
                      >
                        <p className="text-xs text-text-primary leading-snug line-clamp-2 mb-1.5">{bug.title}</p>
                        <div className="flex items-center justify-between">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${sev.bg} ${sev.color}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${sev.dot}`} />
                            {sev.label}
                          </span>
                          {bug.area && (
                            <span className="text-[10px] text-text-muted truncate max-w-[70px]">{bug.area}</span>
                          )}
                        </div>
                        {bug.assignedUser && (
                          <div className="flex items-center gap-1 mt-1.5">
                            <User size={9} className="text-text-muted" />
                            <span className="text-[10px] text-text-muted truncate">{bug.assignedUser.name ?? bug.assignedUser.username}</span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Detail panel ────────────────────────────────────────────────────── */}
      {selectedBug && (
        <aside className="w-80 flex-shrink-0 border-l border-border-subtle bg-bg-sidebar flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span className="text-xs font-medium text-text-secondary">Bug Details</span>
            <button onClick={() => setSelectedBug(null)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors">
              <X size={14} />
            </button>
          </div>

          {/* Fields */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">

            {/* Title */}
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-text-muted">Title</label>
              <input
                ref={titleRef}
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={saveDetail}
                className="w-full text-sm text-text-primary bg-bg-raised border border-border-visible rounded px-2 py-1.5 focus:outline-none focus:border-accent"
              />
            </div>

            {/* Severity + Status row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-text-muted">Severity</label>
                <select
                  value={editSev}
                  onChange={e => { setEditSev(e.target.value); updateBug(selectedBug.id, { severity: e.target.value }) }}
                  className="w-full text-xs bg-bg-raised border border-border-visible rounded px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-text-muted">Status</label>
                <select
                  value={editStatus}
                  onChange={e => { setEditStatus(e.target.value as BugStatus); updateBug(selectedBug.id, { status: e.target.value }) }}
                  className="w-full text-xs bg-bg-raised border border-border-visible rounded px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
                >
                  {STATUS_COLUMNS.map(s => <option key={s} value={s}>{statusLabel[s]}</option>)}
                </select>
              </div>
            </div>

            {/* Area */}
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-text-muted">Area / Component</label>
              <input
                value={editArea}
                onChange={e => setEditArea(e.target.value)}
                onBlur={saveDetail}
                placeholder="e.g. Traefik, Auth, Game Servers"
                className="w-full text-xs bg-bg-raised border border-border-visible rounded px-2 py-1.5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              />
            </div>

            {/* Assignee */}
            {users.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-text-muted">Assigned To</label>
                <select
                  value={editAssignee}
                  onChange={e => { setEditAssignee(e.target.value); updateBug(selectedBug.id, { assignedUserId: e.target.value || null }) }}
                  className="w-full text-xs bg-bg-raised border border-border-visible rounded px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="">Unassigned</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.name ?? u.username}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Description */}
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-text-muted">Description</label>
              <textarea
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                onBlur={saveDetail}
                rows={6}
                placeholder="Steps to reproduce, expected vs actual behaviour, affected versions…"
                className="w-full text-xs bg-bg-raised border border-border-visible rounded px-2 py-1.5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none"
              />
            </div>

            {/* Meta */}
            <div className="text-[10px] text-text-muted space-y-0.5">
              <p>Reported by <span className="text-text-secondary">{selectedBug.reportedBy}</span></p>
              <p>Created {new Date(selectedBug.createdAt).toLocaleDateString()}</p>
              {selectedBug.updatedAt !== selectedBug.createdAt && (
                <p>Updated {new Date(selectedBug.updatedAt).toLocaleDateString()}</p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="p-3 border-t border-border-subtle">
            <button
              onClick={() => deleteBug(selectedBug.id)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-xs hover:border-status-error hover:text-status-error transition-colors"
            >
              <Trash2 size={13} /> Delete Bug
            </button>
          </div>
        </aside>
      )}

      {/* ── Create modal ─────────────────────────────────────────────────────── */}
      {modal && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl w-full max-w-md">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
                <h2 className="text-sm font-semibold text-text-primary">Report a Bug</h2>
                <button onClick={() => setModal(false)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="space-y-1">
                  <label className="text-xs text-text-secondary">Title *</label>
                  <input
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && createBug()}
                    placeholder="Short description of the bug"
                    className="w-full text-sm bg-bg-raised border border-border-visible rounded px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-text-secondary">Severity</label>
                    <select
                      value={form.severity}
                      onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                      className="w-full text-sm bg-bg-raised border border-border-visible rounded px-3 py-2 text-text-primary focus:outline-none focus:border-accent"
                    >
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-text-secondary">Area</label>
                    <input
                      value={form.area}
                      onChange={e => setForm(f => ({ ...f, area: e.target.value }))}
                      placeholder="e.g. Auth, Traefik"
                      className="w-full text-sm bg-bg-raised border border-border-visible rounded px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-text-secondary">Description</label>
                  <textarea
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    rows={4}
                    placeholder="Steps to reproduce, expected vs actual behaviour…"
                    className="w-full text-sm bg-bg-raised border border-border-visible rounded px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-5 py-4 border-t border-border-subtle">
                <button
                  onClick={() => setModal(false)}
                  className="px-4 py-2 rounded text-sm text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createBug}
                  disabled={!form.title.trim() || saving}
                  className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? 'Reporting…' : 'Report Bug'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
