'use client'
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Clock, CheckCircle, XCircle, X, ChevronRight, Sparkles, ToggleRight, ToggleLeft } from 'lucide-react'

interface McpTool {
  id: string
  name: string
  description: string
  execType: string
  execConfig: Record<string, unknown> | null
  inputSchema: Record<string, unknown>
  enabled: boolean
  builtIn: boolean
  proposedAt: string | null
  proposedBy: string | null
  environment: { id: string; name: string }
}

export function PendingToolNotifications() {
  const [tools, setTools]           = useState<McpTool[]>([])
  const [dismissed, setDismissed]   = useState<Set<string>>(new Set())
  const [viewTool, setViewTool]     = useState<McpTool | null>(null)
  const [acting, setActing]         = useState<string | null>(null)

  const fetchPending = useCallback(async () => {
    try {
      const data: McpTool[] = await fetch('/api/tools/pending').then(r => r.json())
      setTools(data)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchPending()
    const timer = setInterval(fetchPending, 20_000)
    return () => clearInterval(timer)
  }, [fetchPending])

  const approve = async (tool: McpTool) => {
    setActing(tool.id)
    try {
      await fetch(`/api/environments/${tool.environment.id}/tools/${tool.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          execConfig: tool.execConfig,
          enabled:    tool.enabled !== false,
        }),
      })
      setTools(prev => prev.filter(t => t.id !== tool.id))
      setViewTool(null)
    } finally { setActing(null) }
  }

  const reject = async (tool: McpTool) => {
    setActing(tool.id)
    try {
      await fetch(`/api/environments/${tool.environment.id}/tools/${tool.id}/reject`, { method: 'POST' })
      setTools(prev => prev.filter(t => t.id !== tool.id))
      setViewTool(null)
    } finally { setActing(null) }
  }

  const dismiss = (id: string) => setDismissed(prev => new Set([...prev, id]))

  const visible = tools.filter(t => !dismissed.has(t.id))
  if (visible.length === 0 && !viewTool) return null

  const inputCls = 'w-full px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'

  return createPortal(
    <>
      {/* ── Notification stack (bottom-right) ── */}
      <div className="fixed bottom-16 right-4 z-40 flex flex-col gap-2 items-end max-w-sm">
        {visible.map(tool => (
          <div key={tool.id}
            className="w-full rounded-xl border border-yellow-500/40 bg-bg-sidebar shadow-2xl overflow-hidden animate-in slide-in-from-right-4 duration-200">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-yellow-500/20 bg-yellow-500/5">
              <Sparkles size={12} className="text-yellow-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-yellow-400 flex-1 truncate">Tool Proposed</span>
              <span className="text-[10px] text-text-muted">{tool.environment.name}</span>
              <button onClick={() => dismiss(tool.id)} className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors">
                <X size={12} />
              </button>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5">
              <p className="text-sm font-medium text-text-primary font-mono">{tool.name}</p>
              <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{tool.description}</p>
              {tool.execConfig && (tool.execConfig as { command?: string }).command && (
                <code className="mt-1.5 block text-[11px] bg-bg-raised rounded px-2 py-1 text-text-secondary font-mono truncate border border-border-subtle">
                  {(tool.execConfig as { command: string }).command}
                </code>
              )}
              {tool.proposedAt && (
                <p className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <Clock size={9} /> {new Date(tool.proposedAt).toLocaleString()}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle bg-bg-card">
              <button
                onClick={() => reject(tool)}
                disabled={acting === tool.id}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50">
                <XCircle size={11} /> Deny
              </button>
              <button
                onClick={() => setViewTool(tool)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-text-secondary border border-border-subtle hover:text-accent hover:border-accent/40 transition-colors">
                <ChevronRight size={11} /> View
              </button>
              <div className="flex-1" />
              <button
                onClick={() => approve(tool)}
                disabled={acting === tool.id}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                <CheckCircle size={11} /> Approve
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Tool detail modal ── */}
      {viewTool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setViewTool(null)}>
          <div className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle">
              <Sparkles size={14} className="text-yellow-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-text-muted uppercase tracking-wide">Tool Proposal · {viewTool.environment.name}</p>
                <h2 className="text-sm font-semibold text-text-primary font-mono truncate">{viewTool.name}</h2>
              </div>
              <button onClick={() => setViewTool(null)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>

            <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
              {/* Description */}
              <p className="text-sm text-text-secondary">{viewTool.description}</p>

              {/* Command */}
              {viewTool.execConfig && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Command</p>
                  <code className="block text-[11px] bg-bg-raised rounded px-3 py-2 text-text-secondary font-mono whitespace-pre-wrap break-all border border-border-subtle">
                    {(viewTool.execConfig as { command?: string }).command ?? JSON.stringify(viewTool.execConfig)}
                  </code>
                </div>
              )}

              {/* Parameters */}
              {Object.keys((viewTool.inputSchema as { properties?: object }).properties ?? {}).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Parameters</p>
                  <div className="space-y-1.5">
                    {Object.entries((viewTool.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }).properties ?? {}).map(([k, v]) => {
                      const required = ((viewTool.inputSchema as { required?: string[] }).required ?? []).includes(k)
                      return (
                        <div key={k} className="flex items-start gap-2 text-xs">
                          <code className="px-1.5 py-0.5 rounded bg-bg-raised text-accent font-mono text-[11px] flex-shrink-0">{k}</code>
                          <span className="text-text-muted">{v.type ?? 'string'}{v.description ? ` — ${v.description}` : ''}</span>
                          {!required && <span className="text-[10px] text-text-muted italic flex-shrink-0">optional</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Edit command before approving */}
              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Edit Command (optional)</p>
                <input
                  className={inputCls + ' font-mono text-xs'}
                  defaultValue={(viewTool.execConfig as { command?: string })?.command ?? ''}
                  onChange={e => setViewTool(prev => prev ? {
                    ...prev,
                    execConfig: { ...prev.execConfig, command: e.target.value },
                  } : null)}
                  placeholder="shell command with {param} placeholders"
                />
                <p className="text-[10px] text-text-muted mt-1">Adjust before approving if needed</p>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-card">
                <div>
                  <p className="text-xs font-medium text-text-primary">Enable immediately on approval</p>
                  <p className="text-[11px] text-text-muted mt-0.5">If off, tool will be approved but not available to the AI yet</p>
                </div>
                <button
                  onClick={() => setViewTool(prev => prev ? { ...prev, enabled: !prev.enabled } : null)}
                  className={`flex-shrink-0 transition-colors ${viewTool.enabled !== false ? 'text-status-healthy' : 'text-text-muted'}`}>
                  {viewTool.enabled !== false ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                </button>
              </div>

              {viewTool.proposedAt && (
                <p className="text-[11px] text-text-muted flex items-center gap-1">
                  <Clock size={10} /> Proposed {new Date(viewTool.proposedAt).toLocaleString()}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle">
              <button
                onClick={() => reject(viewTool)}
                disabled={acting === viewTool.id}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-status-error/40 text-status-error hover:bg-status-error/10 transition-colors disabled:opacity-50">
                <XCircle size={12} /> Deny
              </button>
              <div className="flex-1" />
              <button onClick={() => setViewTool(null)}
                className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button
                onClick={() => approve(viewTool)}
                disabled={acting === viewTool.id}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                <CheckCircle size={12} /> Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  )
}
