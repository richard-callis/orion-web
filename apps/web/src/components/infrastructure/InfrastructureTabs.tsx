'use client'

import { useState } from 'react'
import { Server, KeyRound, HardDrive, FileText, GitBranch, Bell, ServerCrash } from 'lucide-react'
import { IngressPage } from '@/components/ingress/IngressPage'
import { GitOpsPage } from '@/components/gitops/GitOpsPage'
import { Select } from '@/components/ui/Select'
import { OverviewTab } from './tabs/OverviewTab'
import { StorageTab } from './tabs/StorageTab'
import { SecretsTab } from './tabs/SecretsTab'
import { BackupsTab } from './tabs/BackupsTab'
import { LogsTab } from './tabs/LogsTab'
import { AlertsTab } from './tabs/AlertsTab'
import { useClusterEnvironments } from './useClusterEnvironments'
import type { InfraTab } from './types'

export const tabs: { key: InfraTab; label: string; icon: typeof Server }[] = [
  { key: 'overview', label: 'Overview', icon: Server },
  { key: 'ingress', label: 'Ingress', icon: Server },
  { key: 'storage', label: 'Storage', icon: HardDrive },
  { key: 'secrets', label: 'Secrets', icon: KeyRound },
  { key: 'backups', label: 'Backups', icon: FileText },
  { key: 'logs', label: 'Logs', icon: FileText },
  { key: 'gitops', label: 'GitOps', icon: GitBranch },
  { key: 'alerts', label: 'Alerts', icon: Bell },
]

/** Tabs that operate on a single cluster environment. */
const ENV_TABS: InfraTab[] = ['overview', 'storage', 'secrets']

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-text-muted">
      <ServerCrash size={24} className="mb-2 opacity-30" aria-hidden />
      {children}
    </div>
  )
}

export function InfrastructureTabs() {
  const [activeTab, setActiveTab] = useState<InfraTab>('overview')
  const { environments, envId, setEnvId: setPickedEnvId, loading: envsLoading } = useClusterEnvironments()

  const showEnvSelector = ENV_TABS.includes(activeTab)

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Infrastructure sections" className="flex gap-1 flex-wrap border-b border-border-subtle pb-2">
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
              activeTab === t.key
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'
            }`}
          >
            <t.icon size={11} className="inline mr-1" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {showEnvSelector && (
        <>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Cluster environment"
              value={envId}
              onChange={e => setPickedEnvId(e.target.value)}
              className="w-auto text-xs px-2 py-1.5"
              disabled={environments.length === 0}
            >
              <option value="">Select environment…</option>
              {environments.map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
            {envsLoading && <span className="text-xs text-text-muted" role="status">Loading…</span>}
          </div>

          {!envsLoading && environments.length === 0 && (
            <EmptyState>
              <p className="text-xs">No cluster environments found</p>
              <p className="text-[10px] mt-1">Check that environments have type=&quot;cluster&quot; and a gatewayUrl configured</p>
            </EmptyState>
          )}

          {!envId && environments.length > 0 && (
            <EmptyState>
              <p className="text-xs">Select a cluster environment to view infrastructure</p>
            </EmptyState>
          )}
        </>
      )}

      <div role="tabpanel" className="p-4 lg:p-6 space-y-5">
        {/* Env-scoped tabs are keyed on envId so their state resets on switch */}
        {activeTab === 'overview' && envId && <OverviewTab key={envId} envId={envId} />}
        {activeTab === 'ingress' && <IngressPage />}
        {activeTab === 'storage' && envId && <StorageTab key={envId} envId={envId} />}
        {activeTab === 'secrets' && envId && <SecretsTab key={envId} envId={envId} />}
        {activeTab === 'backups' && <BackupsTab />}
        {activeTab === 'logs' && <LogsTab />}
        {activeTab === 'gitops' && <GitOpsPage />}
        {activeTab === 'alerts' && <AlertsTab />}
      </div>
    </div>
  )
}
