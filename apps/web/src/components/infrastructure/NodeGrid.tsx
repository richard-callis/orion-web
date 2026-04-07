'use client'
import type { CachedNode, NodeMetric } from '@/lib/k8s'
import { Server } from 'lucide-react'

function roleColor(role: string[]) {
  if (role.includes('control-plane')) return 'text-accent border-accent/30 bg-accent/5'
  return 'text-text-secondary border-border-subtle bg-bg-card'
}

function barColor(pct: number) {
  if (pct >= 90) return 'bg-status-error'
  if (pct >= 70) return 'bg-status-warning'
  return 'bg-status-healthy'
}

function UsageBar({ label, pct, used, total }: { label: string; pct: number; used: string; total: string }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-0.5">
        <span className="text-[10px] text-text-muted">{label}</span>
        <span className="text-[10px] font-mono text-text-muted">{used}/{total}</span>
      </div>
      <div className="h-1 rounded-full bg-bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor(pct)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  )
}

function parseCpuCores(capacity: string): number {
  if (capacity.endsWith('m')) return parseInt(capacity) / 1000
  return parseInt(capacity)
}

function parseMemKi(capacity: string): number {
  if (capacity.endsWith('Ki')) return parseInt(capacity)
  if (capacity.endsWith('Mi')) return parseInt(capacity) * 1024
  if (capacity.endsWith('Gi')) return parseInt(capacity) * 1024 * 1024
  return parseInt(capacity) / 1024
}

function fmtMem(ki: number): string {
  if (ki >= 1024 * 1024) return `${(ki / 1024 / 1024).toFixed(1)}Gi`
  return `${(ki / 1024).toFixed(0)}Mi`
}

function fmtCpu(nano: number): string {
  const cores = nano / 1e9
  return cores >= 1 ? `${cores.toFixed(2)}c` : `${Math.round(nano / 1e6)}m`
}

interface Props {
  nodes: CachedNode[]
  metrics: NodeMetric[]
  selectedNode?: string | null
  onNodeClick?: (name: string) => void
}

export function NodeGrid({ nodes, metrics, selectedNode, onNodeClick }: Props) {
  if (!nodes.length) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card p-8 text-center text-text-muted text-sm">
        No nodes found — K8s watcher may be initializing
      </div>
    )
  }

  const metricsByName = Object.fromEntries(metrics.map(m => [m.name, m]))

  return (
    <section>
      <h2 className="text-sm font-semibold text-text-secondary mb-3">
        Nodes ({nodes.length})
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {nodes.map(node => {
          const m = metricsByName[node.name]
          const cpuCores  = parseCpuCores(node.cpuCapacity)
          const memKi     = parseMemKi(node.memCapacity)
          const cpuPct    = m ? Math.round((m.cpuUsageNano / 1e9 / cpuCores) * 100) : null
          const memPct    = m ? Math.round((m.memUsageKi / memKi) * 100) : null

          const isSelected = selectedNode === node.name
          return (
            <div
              key={node.name}
              onClick={() => onNodeClick?.(node.name)}
              className={`rounded-lg border p-3 transition-all cursor-pointer ${
                isSelected
                  ? 'border-accent bg-accent/10 text-accent'
                  : roleColor(node.role)
              } ${onNodeClick ? 'hover:border-accent/60' : ''}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Server size={14} className="flex-shrink-0" />
                <span className="text-xs font-mono font-medium truncate" title={node.name}>
                  {node.name.replace('k3s-', '').replace('homelab-', '')}
                </span>
              </div>

              <div className="space-y-0.5 text-xs font-mono text-text-muted mb-2">
                <div className="flex gap-1 items-center">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${node.status === 'Ready' ? 'bg-status-healthy' : 'bg-status-error'}`} />
                  <span>{node.status}</span>
                </div>
                <div className="text-text-muted/70">{node.ip}</div>
                <div className="flex gap-1 flex-wrap mt-1">
                  {node.role.map(r => (
                    <span key={r} className="px-1 py-0.5 rounded bg-bg-raised text-text-muted text-[10px]">{r}</span>
                  ))}
                </div>
              </div>

              {/* Utilization bars */}
              {cpuPct !== null && memPct !== null ? (
                <div className="space-y-1.5 mt-2 pt-2 border-t border-border-subtle/50">
                  <UsageBar
                    label="CPU"
                    pct={cpuPct}
                    used={fmtCpu(m!.cpuUsageNano)}
                    total={`${cpuCores}c`}
                  />
                  <UsageBar
                    label="MEM"
                    pct={memPct}
                    used={fmtMem(m!.memUsageKi)}
                    total={fmtMem(memKi)}
                  />
                </div>
              ) : (
                <div className="mt-2 pt-2 border-t border-border-subtle/50 text-[10px] text-text-muted">
                  metrics unavailable
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
