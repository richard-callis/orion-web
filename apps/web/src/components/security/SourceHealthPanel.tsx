'use client'

import useSWR from 'swr'
import { useEventSource } from '@/hooks/useSSE'
import { Loader2, Shield, Wifi, WifiOff, AlertTriangle } from 'lucide-react'

interface SourceHealth {
  source: string
  lastSeenAt: string | null
  lastWatermark: string | null
  staleAfterMs: number
  environmentId: string | null
  environmentName?: string | null
  status: 'healthy' | 'stale' | 'down' | 'not_configured'
  alertCount24h: number
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

const SOURCE_ICONS: Record<string, React.ElementType> = {
  crowdsec: Shield,
  wazuh: Shield,
  elk: Shield,
  ntopng: Shield,
  host_agent: Wifi,
  gateway_audit: Wifi,
  unifi: Wifi,
  power_probe: Wifi,
  bmc: Wifi,
  flows_edge: Wifi,
  flows_cluster: Wifi,
}

const SOURCE_LABELS: Record<string, string> = {
  crowdsec: 'CrowdSec',
  wazuh: 'Wazuh',
  elk: 'Elasticsearch',
  ntopng: 'ntopng',
  host_agent: 'Host Agent',
  gateway_audit: 'Gateway Audit',
  unifi: 'UniFi',
  power_probe: 'Power Probe',
  bmc: 'BMC (Redfish)',
  flows_edge: 'Edge Flows',
  dns: 'DNS (CoreDNS)',
  udm_ids: 'Gateway IDS',
  udm_fw: 'Gateway Firewall Log',
  k8s_inventory: 'K8s Inventory',
  longhorn_backups: 'Longhorn Backups',
  flows_cluster: 'Cluster Flows',
  hubble: 'Hubble',
}

// Global sources first, then per-environment sources grouped under the environment name.
function groupSources(sources: SourceHealth[]) {
  const groups = new Map<string, { key: string; title: string | null; items: SourceHealth[] }>()
  for (const s of sources) {
    const perEnv = s.environmentId !== null && s.environmentName != null
    const key = perEnv ? `env:${s.environmentId}` : 'global'
    const g = groups.get(key) ?? { key, title: perEnv ? `Environment: ${s.environmentName}` : null, items: [] }
    g.items.push(s)
    groups.set(key, g)
  }
  const label = (s: SourceHealth) => SOURCE_LABELS[s.source] || s.source
  for (const g of groups.values()) g.items.sort((a, b) => label(a).localeCompare(label(b)))
  return [...groups.values()].sort((a, b) =>
    Number(a.key !== 'global') - Number(b.key !== 'global') || (a.title ?? '').localeCompare(b.title ?? ''))
}

export default function SourceHealthPanel() {
  // A failed load keeps the last data (SWR) and shows an error banner with retry.
  const { data, error, isLoading: loading, isValidating, mutate } = useSWR<{ sources?: SourceHealth[] }>('/api/monitoring/security/sources')
  const sources = data?.sources ?? []

  // Real-time: refetch on any 'sources' SSE frame. We do a full refetch
  // rather than trying to use the frame's ID-only payload (R7 invariant).
  useEventSource('/api/monitoring/security/stream?channel=sources', () => { void mutate() })

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    )
  }

  // Not-configured sources are grey and outside the counts below.
  const notConfiguredCount = sources.filter(s => s.status === 'not_configured').length
  const healthyCount = sources.filter(s => s.status === 'healthy').length
  const staleCount = sources.filter(s => s.status === 'stale').length
  const downCount = sources.filter(s => s.status === 'down').length

  return (
    <div className="space-y-3">
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-status-error/40 bg-status-error/5 px-4 py-2 text-sm text-status-error">
          <AlertTriangle size={14} />
          <span>Could not load source health{data ? ' (showing last data)' : ''}.</span>
          <button
            type="button"
            onClick={() => { void mutate() }}
            disabled={isValidating}
            aria-busy={isValidating}
            className="ml-auto underline disabled:opacity-60"
          >
            {isValidating ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {data && (
        <div className="flex items-center gap-3 text-xs text-text-muted mb-2">
          <span className="flex items-center gap-1">
            <Wifi size={12} className="text-status-healthy" /> {healthyCount} healthy
          </span>
          {staleCount > 0 && (
            <span className="flex items-center gap-1">
              <AlertTriangle size={12} className="text-status-warning" /> {staleCount} stale
            </span>
          )}
          {downCount > 0 && (
            <span className="flex items-center gap-1">
              <WifiOff size={12} className="text-status-error" /> {downCount} down
            </span>
          )}
          {notConfiguredCount > 0 && <span>{notConfiguredCount} not configured</span>}
        </div>
      )}

      {sources.length === 0 ? (
        !error && (
          <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-8 text-center text-sm text-text-muted">
            No monitoring sources configured.
          </div>
        )
      ) : (
        groupSources(sources).map(group => (
        <div key={group.key} className="space-y-2">
          {group.title && <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group.title}</h3>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {group.items.map(source => {
            const Icon = SOURCE_ICONS[source.source] || Shield
            const label = SOURCE_LABELS[source.source] || source.source
            const lastSeen = relativeTime(source.lastSeenAt)
            const notConfigured = source.status === 'not_configured'
            const statusColor = notConfigured ? 'text-text-muted' : source.status === 'healthy' ? 'text-status-healthy' :
              source.status === 'stale' ? 'text-status-warning' : 'text-status-error'

            return (
              <div
                key={`${source.environmentId ?? ''}:${source.source}`}
                className={`rounded-xl border p-4 ${
                  notConfigured ? 'border-dashed border-border-subtle' :
                  source.status === 'healthy' ? 'border-border-subtle' :
                  source.status === 'stale' ? 'border-status-warning/40 bg-status-warning/5' :
                  'border-status-error/40 bg-status-error/5'
                }`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <Icon size={16} className={notConfigured ? `${statusColor} opacity-60` : statusColor} />
                  <span className="text-sm font-medium text-text-primary">{label}</span>
                  {source.alertCount24h > 0 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-status-warning/15 text-status-warning">
                      {source.alertCount24h} alerts/24h
                    </span>
                  )}
                  <span className={`ml-auto text-[10px] font-bold uppercase tracking-wide ${statusColor}`}>
                    {notConfigured ? 'not configured' : source.status}
                  </span>
                </div>
                {!notConfigured && (
                  <div className="text-xs text-text-muted space-y-0.5">
                    <div>Last seen: {lastSeen}</div>
                    {source.lastWatermark && <div>Watermark: {source.lastWatermark}</div>}
                    <div>Stale threshold: {Math.round(source.staleAfterMs / 1000)}s</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        </div>
        ))
      )}
    </div>
  )
}
