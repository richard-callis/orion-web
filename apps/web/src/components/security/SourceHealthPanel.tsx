'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Shield, Wifi, WifiOff, AlertTriangle } from 'lucide-react'

interface SourceHealth {
  source: string
  lastSeenAt: string | null
  lastWatermark: string | null
  staleAfterMs: number
  environmentId: string
  status: 'healthy' | 'stale' | 'down'
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
}

const SOURCE_LABELS: Record<string, string> = {
  crowdsec: 'CrowdSec',
  wazuh: 'Wazuh',
  elk: 'Elasticsearch',
  ntopng: 'ntopng',
  host_agent: 'Host Agent',
  gateway_audit: 'Gateway Audit',
}

export default function SourceHealthPanel() {
  const [sources, setSources] = useState<SourceHealth[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring/security/sources')
      const data = await res.json()
      setSources(data.sources ?? [])
    } catch {
      // Silently fail — panel shows gracefully
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Real-time: refetch on any 'sources' SSE frame. We do a full refetch
  // rather than trying to use the frame's ID-only payload (R7 invariant).
  useEffect(() => {
    const source = new EventSource('/api/monitoring/security/stream?channel=sources')
    source.onmessage = () => { load() }
    source.onerror = () => {} // EventSource auto-reconnects
    return () => { source.close() }
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    )
  }

  const healthyCount = sources.filter(s => s.status === 'healthy').length
  const staleCount = sources.filter(s => s.status === 'stale').length
  const downCount = sources.filter(s => s.status === 'down').length

  return (
    <div className="space-y-3">
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
      </div>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-8 text-center text-sm text-text-muted">
          No monitoring sources configured.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sources.map(source => {
            const Icon = SOURCE_ICONS[source.source] || Shield
            const label = SOURCE_LABELS[source.source] || source.source
            const lastSeen = relativeTime(source.lastSeenAt)
            const statusColor = source.status === 'healthy' ? 'text-status-healthy' :
              source.status === 'stale' ? 'text-status-warning' : 'text-status-error'

            return (
              <div
                key={source.source}
                className={`rounded-xl border p-4 ${
                  source.status === 'healthy' ? 'border-border-subtle' :
                  source.status === 'stale' ? 'border-status-warning/40 bg-status-warning/5' :
                  'border-status-error/40 bg-status-error/5'
                }`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <Icon size={16} className={statusColor} />
                  <span className="text-sm font-medium text-text-primary">{label}</span>
                  {source.alertCount24h > 0 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-status-warning/15 text-status-warning">
                      {source.alertCount24h} alerts/24h
                    </span>
                  )}
                  <span className={`ml-auto text-[10px] font-bold uppercase tracking-wide ${statusColor}`}>
                    {source.status}
                  </span>
                </div>
                <div className="text-xs text-text-muted space-y-0.5">
                  <div>Last seen: {lastSeen}</div>
                  {source.lastWatermark && <div>Watermark: {source.lastWatermark}</div>}
                  <div>Stale threshold: {Math.round(source.staleAfterMs / 1000)}s</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
