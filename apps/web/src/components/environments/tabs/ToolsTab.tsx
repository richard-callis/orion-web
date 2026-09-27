'use client'

import { useState } from 'react'
import { CheckCircle, Clock, Pencil, Plus, Trash2, X, XCircle, Zap, ZapOff } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { ToolFormModal } from '../modals/ToolFormModal'
import { ToolDetailModal } from '../modals/ToolDetailModal'
import { EmptyCard } from '../shared'
import { EXEC_TYPE_LABELS, type Environment, type McpTool } from '../types'

export function ToolsTab({ env, onEnvChange, onReload }: {
  env: Environment
  onEnvChange: (env: Environment) => void
  onReload: () => Promise<void>
}) {
  const toast = useToast()
  // Tool form: undefined = closed, null = create, McpTool = edit
  const [formTool, setFormTool] = useState<McpTool | null | undefined>(undefined)
  // Detail modal tracks by id so it reflects updates to env.tools
  const [detailId, setDetailId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [approving, setApproving] = useState<string | null>(null)

  const pending = env.tools.filter(t => t.status === 'pending')
  const active = env.tools.filter(t => t.status === 'active')
  const detail = detailId ? env.tools.find(t => t.id === detailId) ?? null : null

  const replaceTool = (updated: McpTool) =>
    onEnvChange({ ...env, tools: env.tools.map(t => t.id === updated.id ? updated : t) })

  const toggleTool = async (tool: McpTool) => {
    try {
      replaceTool(await apiFetch<McpTool>(`/api/environments/${env.id}/tools/${tool.id}`, {
        method: 'PUT', body: { enabled: !tool.enabled },
      }))
    } catch (e) {
      toast.error(`Failed to ${tool.enabled ? 'disable' : 'enable'} tool: ${errorMessage(e)}`)
    }
  }

  const deleteTool = async (toolId: string) => {
    setConfirmDelete(null)
    try {
      await apiFetch(`/api/environments/${env.id}/tools/${toolId}`, { method: 'DELETE' })
      onEnvChange({ ...env, tools: env.tools.filter(t => t.id !== toolId) })
    } catch (e) {
      toast.error(`Failed to delete tool: ${errorMessage(e)}`)
    }
  }

  const review = async (toolId: string, action: 'approve' | 'reject') => {
    setApproving(toolId)
    try {
      replaceTool(await apiFetch<McpTool>(`/api/environments/${env.id}/tools/${toolId}/${action}`, { method: 'POST', body: {} }))
    } catch (e) {
      toast.error(`Failed to ${action} tool: ${errorMessage(e)}`)
    } finally {
      setApproving(null)
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {pending.map(tool => (
        <div key={tool.id} className="rounded-lg border-2 border-orange-500 bg-orange-500/5 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-b border-orange-500/30">
            <Clock size={12} className="text-orange-400 flex-shrink-0" aria-hidden />
            <span className="text-xs font-semibold text-orange-400 flex-1">Pending Approval</span>
            {tool.proposedAt && (
              <span className="text-[10px] text-orange-400/70">{new Date(tool.proposedAt).toLocaleString()}</span>
            )}
          </div>
          <div className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-text-primary font-mono">{tool.name}</span>
                <p className="text-xs text-text-muted mt-0.5">{tool.description}</p>
                {tool.execConfig && (
                  <code className="mt-1.5 block text-[11px] bg-bg-raised rounded px-2 py-1 text-text-secondary font-mono truncate border border-orange-500/20">
                    {(tool.execConfig as { command?: string }).command ?? ''}
                  </code>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => review(tool.id, 'reject')} disabled={approving === tool.id}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50">
                  <XCircle size={12} aria-hidden /> Reject
                </button>
                <Button variant="secondary" onClick={() => setDetailId(tool.id)}>View</Button>
                <button onClick={() => review(tool.id, 'approve')} disabled={approving === tool.id}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                  <CheckCircle size={12} aria-hidden /> {approving === tool.id ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {active.filter(t => t.enabled).length} of {active.length} active tools enabled
        </p>
        <Button onClick={() => setFormTool(null)}>
          <Plus size={12} aria-hidden /> Add Tool
        </Button>
      </div>

      {active.length === 0 ? (
        <EmptyCard>No tools configured. Add a custom tool or connect a gateway to sync built-in tools.</EmptyCard>
      ) : (
        <ul className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
          {active.map(tool => (
            <li key={tool.id} className="flex items-start gap-3 px-4 py-3 hover:bg-bg-raised transition-colors">
              <button
                role="switch"
                aria-checked={tool.enabled}
                aria-label={tool.enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
                title={tool.enabled ? 'Disable' : 'Enable'}
                onClick={() => toggleTool(tool)}
                className={`mt-0.5 flex-shrink-0 transition-colors ${tool.enabled ? 'text-status-healthy' : 'text-text-muted hover:text-status-healthy'}`}>
                {tool.enabled ? <Zap size={14} aria-hidden /> : <ZapOff size={14} aria-hidden />}
              </button>
              <button className="flex-1 min-w-0 text-left" onClick={() => setDetailId(tool.id)}>
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary font-mono">{tool.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle">
                    {EXEC_TYPE_LABELS[tool.execType] ?? tool.execType}
                  </span>
                  {tool.builtIn && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">built-in</span>
                  )}
                  {!tool.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle">disabled</span>
                  )}
                </span>
                <span className="block text-xs text-text-muted mt-0.5 truncate">{tool.description}</span>
              </button>
              <div className="flex items-center gap-1 flex-shrink-0">
                {!tool.builtIn && (
                  <IconButton label={`Edit ${tool.name}`} onClick={() => setFormTool(tool)} className="hover:text-accent">
                    <Pencil size={12} />
                  </IconButton>
                )}
                {confirmDelete === tool.id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => deleteTool(tool.id)}
                      className="px-2 py-0.5 text-[10px] rounded bg-status-error text-white hover:bg-status-error/80">
                      Confirm
                    </button>
                    <IconButton label="Cancel delete" onClick={() => setConfirmDelete(null)}>
                      <X size={11} />
                    </IconButton>
                  </div>
                ) : (
                  <IconButton label={`Delete ${tool.name}`} onClick={() => setConfirmDelete(tool.id)} className="hover:text-status-error">
                    <Trash2 size={12} />
                  </IconButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {formTool !== undefined && (
        <ToolFormModal
          env={env}
          tool={formTool}
          onClose={() => setFormTool(undefined)}
          onSaved={async () => { await onReload(); setFormTool(undefined) }}
        />
      )}

      {detail && (
        <ToolDetailModal
          tool={detail}
          onClose={() => setDetailId(null)}
          onToggle={toggleTool}
          onEdit={t => { setDetailId(null); setFormTool(t) }}
        />
      )}
    </div>
  )
}
