'use client'
import { useState, useEffect, useCallback } from 'react'
import { Shield, Eye, EyeOff, Check, X, RefreshCw, ChevronDown, ChevronUp, Lock } from 'lucide-react'

interface AgentRestriction {
  agentId: string
  agent: { id: string; name: string }
}

interface Tool {
  id: string
  name: string
  description: string
  execType: string
  enabled: boolean
  builtIn: boolean
  status: string
  proposedAt: string | null
  environment: { id: string; name: string }
  agentRestrictions: AgentRestriction[]
}

export default function ToolPermissionsPage() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [envFilter, setEnvFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetch('/api/admin/tools').then(r => r.json()) as Tool[]
      setTools(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function patch(id: string, update: { enabled?: boolean; status?: string }) {
    setSaving(id)
    try {
      const updated = await fetch('/api/admin/tools', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...update }),
      }).then(r => r.json()) as Tool
      setTools(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t))
    } finally {
      setSaving(null)
    }
  }

  const environments = Array.from(new Set(tools.map(t => t.environment.name))).sort()

  const filtered = tools.filter(t => {
    if (envFilter !== 'all' && t.environment.name !== envFilter) return false
    if (statusFilter === 'pending' && t.status !== 'pending') return false
    if (statusFilter === 'disabled' && t.enabled) return false
    if (statusFilter === 'restricted' && t.agentRestrictions.length === 0) return false
    return true
  })

  const pendingCount = tools.filter(t => t.status === 'pending').length

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Shield size={18} className="text-accent" /> Tool Permissions
        </h1>
        <p className="text-sm text-text-muted mt-0.5">
          Review, enable, disable, and approve MCP tools across all environments.
        </p>
      </div>

      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <Lock size={14} />
          <span>{pendingCount} tool{pendingCount !== 1 ? 's' : ''} pending approval — review below.</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={envFilter}
          onChange={e => setEnvFilter(e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="all">All environments</option>
          {environments.map(env => <option key={env} value={env}>{env}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending approval</option>
          <option value="disabled">Disabled</option>
          <option value="restricted">Agent-restricted</option>
        </select>
        <button onClick={load} disabled={loading} className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary hover:border-border-visible transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-sm text-text-muted">Loading tools…</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center gap-3">
          <Shield size={32} className="text-text-muted/40" />
          <p className="text-sm text-text-secondary">No tools match the current filter.</p>
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden divide-y divide-border-subtle">
          {filtered.map(tool => {
            const isExpanded = expanded.has(tool.id)
            const isSaving = saving === tool.id
            return (
              <div key={tool.id} className="bg-bg-surface">
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Expand toggle */}
                  <button
                    onClick={() => setExpanded(prev => {
                      const next = new Set(prev)
                      next.has(tool.id) ? next.delete(tool.id) : next.add(tool.id)
                      return next
                    })}
                    className="text-text-muted hover:text-text-primary flex-shrink-0"
                  >
                    {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>

                  {/* Name + env */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary truncate">{tool.name}</span>
                      {tool.builtIn && <span className="text-[10px] text-text-muted border border-border-subtle rounded px-1">built-in</span>}
                      {tool.status === 'pending' && (
                        <span className="text-[10px] text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded px-1">pending</span>
                      )}
                      {tool.agentRestrictions.length > 0 && (
                        <span className="text-[10px] text-blue-400 border border-blue-400/30 bg-blue-400/10 rounded px-1 flex items-center gap-0.5">
                          <Lock size={8} />{tool.agentRestrictions.length} agent{tool.agentRestrictions.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-text-muted">{tool.environment.name}</span>
                      <span className="text-[10px] text-text-muted/50">·</span>
                      <span className="text-[10px] text-text-muted">{tool.execType}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {tool.status === 'pending' && (
                      <>
                        <button
                          onClick={() => patch(tool.id, { status: 'active', enabled: true })}
                          disabled={isSaving}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                        >
                          <Check size={10} /> Approve
                        </button>
                        <button
                          onClick={() => patch(tool.id, { status: 'rejected', enabled: false })}
                          disabled={isSaving}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                          <X size={10} /> Reject
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => patch(tool.id, { enabled: !tool.enabled })}
                      disabled={isSaving || tool.status === 'pending'}
                      title={tool.enabled ? 'Disable tool' : 'Enable tool'}
                      className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded border transition-colors disabled:opacity-40 ${
                        tool.enabled
                          ? 'border-border-subtle text-text-muted hover:border-red-500/40 hover:text-red-400'
                          : 'border-border-subtle text-text-muted hover:border-emerald-500/40 hover:text-emerald-400'
                      }`}
                    >
                      {tool.enabled ? <><Eye size={10} /> Enabled</> : <><EyeOff size={10} /> Disabled</>}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-10 pb-3 space-y-2">
                    <p className="text-xs text-text-muted">{tool.description}</p>
                    {tool.agentRestrictions.length > 0 && (
                      <div>
                        <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">Restricted to agents</p>
                        <div className="flex flex-wrap gap-1.5">
                          {tool.agentRestrictions.map(r => (
                            <span key={r.agentId} className="text-[10px] px-2 py-0.5 bg-bg-card border border-border-subtle rounded text-text-secondary">
                              {r.agent.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
