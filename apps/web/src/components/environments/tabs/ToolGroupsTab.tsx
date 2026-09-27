'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Pencil, Plus, Shield, Trash2, X, Zap } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { ToolGroupModal } from '../modals/ToolGroupModal'
import { EmptyCard, LoadingBlock } from '../shared'
import type { Environment, ToolGroup } from '../types'

const TIER_BADGE: Record<string, string> = {
  admin: 'bg-orange-500/15 text-orange-400',
  operator: 'bg-blue-500/15 text-blue-400',
}

export function ToolGroupsTab({ env }: { env: Environment }) {
  const toast = useToast()
  // Keyed on the environment: switching env can never show another env's groups.
  const { data: groups, mutate } = useSWR<ToolGroup[]>(`/api/tool-groups?environmentId=${env.id}`)
  // undefined = closed, null = create
  const [modalGroup, setModalGroup] = useState<ToolGroup | null | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn() } catch (e) { toast.error(`Failed to ${label}: ${errorMessage(e)}`) }
    await mutate()
  }

  const deleteGroup = (id: string) => {
    setConfirmDelete(null)
    return run('delete tool group', () => apiFetch(`/api/tool-groups/${id}`, { method: 'DELETE' }))
  }
  const addTool = (tgId: string, toolId: string) => {
    setAddingTo(null)
    return run('add tool to group', () => apiFetch(`/api/tool-groups/${tgId}/tools`, { method: 'POST', body: { toolId } }))
  }
  const removeTool = (tgId: string, toolId: string) =>
    run('remove tool from group', () => apiFetch(`/api/tool-groups/${tgId}/tools?toolId=${encodeURIComponent(toolId)}`, { method: 'DELETE' }))

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Tool Groups</p>
          <p className="text-xs text-text-muted mt-0.5">Group tools together and set a minimum user tier required to run them</p>
        </div>
        <Button onClick={() => setModalGroup(null)}>
          <Plus size={12} aria-hidden /> New Group
        </Button>
      </div>

      {!groups ? (
        <LoadingBlock />
      ) : groups.length === 0 ? (
        <EmptyCard>No tool groups yet. Create one to group tools and set access tiers.</EmptyCard>
      ) : (
        <div className="space-y-3">
          {groups.map(tg => {
            const addable = env.tools.filter(t => t.status === 'active' && !tg.tools.some(tt => tt.toolId === t.id))
            return (
              <div key={tg.id} className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-raised/50">
                  <Layers size={13} className="text-text-muted shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">{tg.name}</p>
                    {tg.description && <p className="text-xs text-text-muted">{tg.description}</p>}
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-sm font-medium flex items-center gap-1 ${TIER_BADGE[tg.minimumTier] ?? 'bg-bg-raised text-text-muted border border-border-subtle'}`}>
                    <Shield size={9} aria-hidden /> min: {tg.minimumTier}
                  </span>
                  <IconButton label={`Edit ${tg.name}`} onClick={() => setModalGroup(tg)} className="hover:text-accent">
                    <Pencil size={12} />
                  </IconButton>
                  {confirmDelete === tg.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => deleteGroup(tg.id)} className="px-2 py-0.5 text-[10px] rounded-sm bg-status-error text-white">Del</button>
                      <IconButton label="Cancel delete" onClick={() => setConfirmDelete(null)}><X size={10} /></IconButton>
                    </div>
                  ) : (
                    <IconButton label={`Delete ${tg.name}`} onClick={() => setConfirmDelete(tg.id)} className="hover:text-status-error">
                      <Trash2 size={12} />
                    </IconButton>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide">Tools in group ({tg.tools.length})</p>
                    <button onClick={() => setAddingTo(addingTo === tg.id ? null : tg.id)} aria-expanded={addingTo === tg.id}
                      className="flex items-center gap-1 text-[11px] text-text-muted hover:text-accent transition-colors">
                      <Plus size={10} aria-hidden /> Add
                    </button>
                  </div>
                  {addingTo === tg.id && (
                    <div className="rounded-sm border border-border-subtle bg-bg-raised p-2 space-y-1 max-h-36 overflow-y-auto">
                      {addable.map(t => (
                        <button key={t.id} onClick={() => addTool(tg.id, t.id)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs text-left hover:bg-bg-card transition-colors">
                          <Zap size={11} className="text-text-muted" aria-hidden />
                          <span className="font-mono text-text-primary">{t.name}</span>
                        </button>
                      ))}
                      {addable.length === 0 && <p className="text-xs text-text-muted text-center py-2">All tools already in group</p>}
                    </div>
                  )}
                  {tg.tools.length === 0 ? (
                    <p className="text-xs text-text-muted">No tools in this group yet</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {tg.tools.map(tt => (
                        <span key={tt.toolId} className="flex items-center gap-1 px-2 py-0.5 rounded-sm bg-bg-raised border border-border-subtle text-[11px] text-text-secondary font-mono">
                          {tt.tool.name}
                          <button onClick={() => removeTool(tg.id, tt.toolId)} aria-label={`Remove ${tt.tool.name} from ${tg.name}`}
                            className="text-text-muted hover:text-status-error transition-colors">
                            <X size={9} aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {tg.agentAccess.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1">Agent group access</p>
                      <div className="flex flex-wrap gap-1.5">
                        {tg.agentAccess.map(aa => (
                          <span key={aa.agentGroupId} className="px-2 py-0.5 rounded-sm bg-accent/10 border border-accent/20 text-[11px] text-accent">
                            {aa.agentGroup.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modalGroup !== undefined && (
        <ToolGroupModal
          envId={env.id}
          group={modalGroup}
          onClose={() => setModalGroup(undefined)}
          onSaved={async () => { await mutate(); setModalGroup(undefined) }}
        />
      )}
    </div>
  )
}
