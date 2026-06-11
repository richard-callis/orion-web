'use client'
import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, XCircle, RefreshCw, Activity, Database, Cloud, Bot, Cpu, Clock, type LucideIcon } from 'lucide-react'

interface WorkerHealth {
  running: number
  queued: number
  lastActivityAt: string | null
  active: boolean
}

interface HealthData {
  k8s: boolean
  db: boolean
  claude: boolean
  externalModels: Record<string, boolean>
  worker: WorkerHealth
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {ok
        ? <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />
        : <XCircle size={14} className="text-red-400 flex-shrink-0" />
      }
      <span className={`text-sm ${ok ? 'text-text-primary' : 'text-red-400'}`}>{label}</span>
    </div>
  )
}

function Card({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
        <Icon size={14} className="text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="px-4 py-4 space-y-2.5">{children}</div>
    </div>
  )
}

export default function SystemHealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/health')
      const json = await res.json() as HealthData
      setData(json)
      setLastChecked(new Date())
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const extEntries = Object.entries(data?.externalModels ?? {})

  return (
    <div className="p-6 space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Activity size={18} className="text-accent" /> System Health
          </h1>
          <p className="text-sm text-text-muted mt-0.5">Live status of all ORION subsystems. Auto-refreshes every 30 s.</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary hover:border-border-visible transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {lastChecked && (
        <p className="text-[11px] text-text-muted flex items-center gap-1">
          <Clock size={10} /> Last checked: {lastChecked.toLocaleTimeString()}
        </p>
      )}

      {loading && !data && (
        <div className="text-sm text-text-muted">Checking health…</div>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Core services */}
          <Card title="Core Services" icon={Database}>
            <StatusDot ok={data.db} label="Database (PostgreSQL)" />
            <StatusDot ok={data.k8s} label="Kubernetes API" />
            <StatusDot ok={data.claude} label="Claude credentials" />
          </Card>

          {/* Worker */}
          <Card title="Worker" icon={Bot}>
            <StatusDot ok={data.worker.active} label={data.worker.active ? 'Worker active' : 'Worker idle / no recent activity'} />
            <div className="grid grid-cols-2 gap-3 mt-1">
              <div className="rounded bg-bg-raised border border-border-subtle px-3 py-2 text-center">
                <p className="text-2xl font-bold text-text-primary">{data.worker.running}</p>
                <p className="text-[10px] text-text-muted mt-0.5">Running</p>
              </div>
              <div className="rounded bg-bg-raised border border-border-subtle px-3 py-2 text-center">
                <p className="text-2xl font-bold text-text-primary">{data.worker.queued}</p>
                <p className="text-[10px] text-text-muted mt-0.5">Queued</p>
              </div>
            </div>
            {data.worker.lastActivityAt && (
              <p className="text-[10px] text-text-muted flex items-center gap-1 mt-1">
                <Clock size={9} /> Last activity: {new Date(data.worker.lastActivityAt).toLocaleString()}
              </p>
            )}
          </Card>

          {/* External models */}
          <Card title="External Models" icon={Cpu}>
            {extEntries.length === 0 ? (
              <p className="text-xs text-text-muted">No external models configured.</p>
            ) : (
              extEntries.map(([id, ok]) => (
                <StatusDot key={id} ok={ok} label={id} />
              ))
            )}
          </Card>

          {/* K8s + cloud summary */}
          <Card title="Infrastructure" icon={Cloud}>
            <StatusDot ok={data.k8s} label={data.k8s ? 'Kubernetes reachable' : 'Kubernetes unavailable (Docker-only mode)'} />
            <p className="text-[10px] text-text-muted mt-1">
              K8s is optional — ORION functions without it in Docker-only deployments.
            </p>
          </Card>
        </div>
      )}
    </div>
  )
}
