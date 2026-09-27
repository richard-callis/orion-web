'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Bot, Plus, X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { EmptyCard } from '../shared'
import type { AllAgent, Environment } from '../types'

export function AgentsTab({ env, onEnvChange }: { env: Environment; onEnvChange: (env: Environment) => void }) {
  const toast = useToast()
  const { data: allAgents = [] } = useSWR<AllAgent[]>('/api/agents', { revalidateOnFocus: false })
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [linking, setLinking] = useState(false)

  const candidates = allAgents.filter(a =>
    !env.agents.some(ae => ae.agentId === a.id) &&
    (search === '' || a.name.toLowerCase().includes(search.toLowerCase())),
  )

  const link = async (agentId: string) => {
    setLinking(true)
    try {
      const l = await apiFetch<{ id: string; agentId: string; agent: AllAgent }>(`/api/environments/${env.id}/agents`, {
        method: 'POST', body: { agentId },
      })
      onEnvChange({ ...env, agents: [...env.agents, { id: l.id, agentId: l.agentId, agent: l.agent }] })
      setShowAdd(false)
      setSearch('')
    } catch (e) {
      toast.error(`Failed to link agent: ${errorMessage(e)}`)
    } finally {
      setLinking(false)
    }
  }

  const unlink = async (agentId: string) => {
    try {
      await apiFetch(`/api/environments/${env.id}/agents/${agentId}`, { method: 'DELETE' })
      onEnvChange({ ...env, agents: env.agents.filter(a => a.agentId !== agentId) })
    } catch (e) {
      toast.error(`Failed to unlink agent: ${errorMessage(e)}`)
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Linked Agents</p>
          <p className="text-xs text-text-muted mt-0.5">Agents linked here get priority routing to this environment&apos;s gateway tools</p>
        </div>
        <Button onClick={() => { setShowAdd(v => !v); setSearch('') }} aria-expanded={showAdd}>
          <Plus size={12} aria-hidden /> Link Agent
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
          <p className="text-xs font-medium text-text-muted">Select an agent to link</p>
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents…" aria-label="Search agents" />
          <div className="max-h-48 overflow-y-auto rounded border border-border-subtle divide-y divide-border-subtle">
            {candidates.map(a => (
              <button key={a.id} onClick={() => link(a.id)} disabled={linking}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-raised transition-colors disabled:opacity-50">
                <Bot size={13} className="text-text-muted flex-shrink-0" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium text-text-primary">{a.name}</span>
                  <span className="block text-[11px] text-text-muted">{a.role ?? a.type}</span>
                </span>
              </button>
            ))}
            {candidates.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-muted text-center">
                {search ? 'No matching agents' : 'All agents are already linked'}
              </p>
            )}
          </div>
        </div>
      )}

      {env.agents.length === 0 ? (
        <EmptyCard>No agents linked to this environment.</EmptyCard>
      ) : (
        <ul className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
          {env.agents.map(ae => (
            <li key={ae.id} className="flex items-center gap-3 px-4 py-3">
              <Bot size={14} className="text-text-muted flex-shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{ae.agent.name}</p>
                <p className="text-xs text-text-muted">{ae.agent.role ?? ae.agent.type}</p>
              </div>
              <IconButton label={`Unlink ${ae.agent.name}`} onClick={() => unlink(ae.agentId)} className="hover:text-status-error">
                <X size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
