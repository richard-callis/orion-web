'use client'

import { useCallback, useState } from 'react'
import { Plus } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import { apiFetch } from '@/lib/api'
import { EnvironmentHeader } from './EnvironmentHeader'
import { ToolsTab } from './tabs/ToolsTab'
import { AgentsTab } from './tabs/AgentsTab'
import { ToolGroupsTab } from './tabs/ToolGroupsTab'
import { AccessTab } from './tabs/AccessTab'
import { EnvironmentFormModal } from './modals/EnvironmentFormModal'
import { DeployGatewayModal } from './modals/DeployGatewayModal'
import { ClusterBootstrapModal } from './modals/ClusterBootstrapModal'
import { TYPE_ICONS } from './shared'
import { STATUS_DOT, type EnvTab, type Environment } from './types'

type Modal = 'create' | 'edit' | 'deploy' | 'bootstrap' | null

const TABS: { id: EnvTab; label: (env: Environment) => string }[] = [
  { id: 'tools',  label: env => `Tools (${env.tools.length})` },
  { id: 'agents', label: env => `Agents (${env.agents.length})` },
  { id: 'groups', label: () => 'Tool Groups' },
  { id: 'access', label: () => 'Access' },
]

export function EnvironmentsPage({ initialEnvironments }: { initialEnvironments: Environment[] }) {
  const [environments, setEnvironments] = useState<Environment[]>(initialEnvironments)
  const [selectedId, setSelectedId] = useState<string | null>(initialEnvironments[0]?.id ?? null)
  const [tab, setTab] = useState<EnvTab>('tools')
  const [modal, setModal] = useState<Modal>(null)

  const selected = environments.find(e => e.id === selectedId) ?? null

  const reload = useCallback(async () => {
    const data = await apiFetch<Environment[]>('/api/environments').catch(() => null)
    if (!data) return
    setEnvironments(data)
    setSelectedId(prev => (prev && data.some(e => e.id === prev)) ? prev : data[0]?.id ?? null)
  }, [])

  const updateEnv = useCallback((updated: Environment) => {
    setEnvironments(prev => prev.map(e => e.id === updated.id ? updated : e))
  }, [])

  const select = (id: string) => { setSelectedId(id); setTab('tools') }

  return (
    <div className="flex h-full overflow-hidden">

      <aside className="w-64 shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden" aria-label="Environments">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Environments</h2>
          <IconButton label="New environment" onClick={() => setModal('create')} className="hover:text-accent hover:bg-bg-raised">
            <Plus size={14} />
          </IconButton>
        </div>

        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {environments.map(env => {
            const pending = env.tools.filter(t => t.status === 'pending').length
            return (
              <button
                key={env.id}
                onClick={() => select(env.id)}
                aria-current={selectedId === env.id ? 'true' : undefined}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                  selectedId === env.id ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[env.status] ?? 'bg-text-muted'}`} aria-hidden />
                  <span className="flex items-center gap-1.5 text-xs font-medium truncate">
                    <span aria-hidden>{TYPE_ICONS[env.type]}</span>
                    {env.name}
                  </span>
                </span>
                <span className="text-[10px] text-text-muted mt-0.5 pl-3.5 truncate flex items-center gap-1.5">
                  {env.tools.filter(t => t.enabled && t.status === 'active').length} tools enabled · {env.status}
                  {pending > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-orange-500 text-white text-[9px] font-bold"
                      aria-label={`${pending} pending tool proposals`}>
                      {pending}
                    </span>
                  )}
                </span>
              </button>
            )
          })}

          {environments.length === 0 && (
            <p className="text-xs text-text-muted text-center py-8">No environments yet</p>
          )}
        </nav>
      </aside>

      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <EnvironmentHeader
            key={selected.id}
            env={selected}
            onBootstrap={() => setModal('bootstrap')}
            onDeploy={() => setModal('deploy')}
            onEdit={() => setModal('edit')}
          />

          <div role="tablist" aria-label="Environment sections" className="flex gap-0 border-b border-border-subtle shrink-0 px-6">
            {TABS.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`py-2.5 px-4 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
                }`}>
                {t.label(selected)}
              </button>
            ))}
          </div>

          {/* Keyed on the environment so per-tab state and fetches reset on switch */}
          <div role="tabpanel" className="flex-1 overflow-y-auto p-6" key={selected.id}>
            {tab === 'tools'  && <ToolsTab env={selected} onEnvChange={updateEnv} onReload={reload} />}
            {tab === 'agents' && <AgentsTab env={selected} onEnvChange={updateEnv} />}
            {tab === 'groups' && <ToolGroupsTab env={selected} />}
            {tab === 'access' && <AccessTab env={selected} />}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Select an environment or create one to get started
        </div>
      )}

      {(modal === 'create' || (modal === 'edit' && selected)) && (
        <EnvironmentFormModal
          mode={modal}
          env={modal === 'edit' ? selected : null}
          onClose={() => setModal(null)}
          onSaved={env => {
            if (modal === 'create') {
              setEnvironments(prev => [...prev, env])
              setSelectedId(env.id)
            } else {
              updateEnv(env)
            }
            setModal(null)
          }}
          onDeleted={id => {
            const remaining = environments.filter(e => e.id !== id)
            setEnvironments(remaining)
            setSelectedId(remaining[0]?.id ?? null)
            setModal(null)
          }}
        />
      )}

      {modal === 'deploy' && selected && (
        <DeployGatewayModal env={selected} onClose={() => setModal(null)} onDeployed={reload} />
      )}

      {modal === 'bootstrap' && selected && (
        <ClusterBootstrapModal env={selected} onClose={() => setModal(null)} onBootstrapped={reload} />
      )}
    </div>
  )
}
