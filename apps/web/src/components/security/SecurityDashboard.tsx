'use client'

import { useState, useEffect, useCallback } from 'react'
import { Shield, AlertTriangle, Activity, Zap, CheckCircle2, Loader2, Info } from 'lucide-react'
import Link from 'next/link'
import AlertFeed from './AlertFeed'
import FlowTable from './FlowTable'
import SourceHealthPanel from './SourceHealthPanel'
import SecuritySettings from './SecuritySettings'

function RiskScoreGauge({ score }: { score: number }) {
  const getColor = (s: number) => {
    if (s >= 75) return 'text-status-error'
    if (s >= 50) return 'text-status-warning'
    if (s >= 25) return 'text-yellow-400'
    return 'text-status-success'
  }
  const getLabel = (s: number) => {
    if (s >= 75) return 'Critical'
    if (s >= 50) return 'High'
    if (s >= 25) return 'Medium'
    return 'Low'
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-5 flex flex-col items-center">
      <div className="flex items-center gap-2 mb-3">
        <Shield size={16} className="text-text-muted" />
        <span className="text-sm font-medium text-text-muted">Risk Score</span>
      </div>
      <div className={`text-5xl font-bold ${getColor(score)}`}>{score}</div>
      <div className={`text-sm font-medium mt-1 ${getColor(score)}`}>{getLabel(score)}</div>
      <div className="w-full h-2 bg-bg-raised rounded-full mt-3 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            score >= 75 ? 'bg-status-error' : score >= 50 ? 'bg-status-warning' : 'bg-status-success'
          }`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType; label: string; value: number | string; color: string
}) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={color} />
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <div className="text-2xl font-bold text-text-primary">{value}</div>
    </div>
  )
}

type Tab = 'incidents' | 'investigations' | 'alerts' | 'approvals' | 'flows' | 'sources' | 'settings'

export default function SecurityDashboard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('incidents')

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring/security/overview')
      if (!res.ok) throw new Error(`${res.status}`)
      const d = await res.json()
      setData(d)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOverview()
    const interval = setInterval(loadOverview, 30_000)
    return () => clearInterval(interval)
  }, [loadOverview])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-status-error text-sm p-4 border border-status-error/20 bg-status-error/5 rounded-lg">
        Error loading security data: {error}
      </div>
    )
  }

  const tabs: { key: Tab; label: string; badge?: number; href?: string }[] = [
    { key: 'incidents', label: 'Incidents', badge: data?.activeIncidents, href: '/security/incidents' },
    { key: 'investigations', label: 'Investigations', href: '/security/investigations' },
    { key: 'alerts', label: 'Alerts' },
    { key: 'approvals', label: 'Approvals', badge: data?.pendingApprovals, href: '/security/approvals' },
    { key: 'flows', label: 'Flows' },
    { key: 'sources', label: 'Sources' },
    { key: 'settings', label: 'Settings' },
  ]

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Shield size={20} className="text-accent" />
          Security Dashboard
        </h1>
        <div className="flex gap-1 bg-bg-raised rounded-lg p-0.5">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                tab === t.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  tab === t.key ? 'bg-white/20' : 'bg-bg-raised'
                }`}>{t.badge}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {tab === 'incidents' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <RiskScoreGauge score={data?.riskScore ?? 0} />
            <StatCard icon={AlertTriangle} label="Open Incidents" value={data?.activeIncidents ?? 0} color="text-status-warning" />
            <StatCard icon={CheckCircle2} label="Blocks" value={data?.blockCount ?? 0} color="text-blue-400" />
            <StatCard icon={Zap} label="Anomalies" value={data?.anomalyCount ?? 0} color="text-purple-400" />
          </div>

          {!data?.recentAlerts?.length && !data?.activeIncidents && (
            <div className="rounded-lg border border-border-subtle bg-bg-surface px-5 py-6 flex gap-4 items-start">
              <Info size={18} className="text-accent shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm">
                <div className="font-medium text-text-primary">No security signals yet</div>
                <p className="text-xs text-text-muted leading-relaxed">
                  To start monitoring, connect external sources (CrowdSec, Wazuh, ELK, ntopng) or add K8s cluster environments.
                  The correlator automatically groups raw events into incidents.
                </p>
                <ol className="text-xs text-text-muted space-y-1 list-decimal list-inside">
                  <li>Go to the <strong className="text-text-primary">Settings</strong> tab and seed default correlation rules</li>
                  <li>Configure source URLs or connect a cluster environment in Infrastructure</li>
                  <li>Optionally inject demo events to test the pipeline end-to-end</li>
                </ol>
              </div>
            </div>
          )}

          {data?.recentIncidents?.length ? (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary">Recent Incidents</span>
                <Link href="/security/incidents" className="text-xs text-accent hover:underline">
                  View all
                </Link>
              </div>
              <div className="divide-y divide-border-subtle">
                {data.recentIncidents.map((inc: any) => (
                  <Link
                    key={inc.id}
                    href={`/security/incidents/${inc.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-bg-raised transition-colors"
                  >
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                      inc.severity >= 80 ? 'bg-status-error/15 text-status-error' :
                      inc.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
                      'bg-bg-raised text-text-muted'
                    }`}>
                      {inc.severity}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary truncate">{inc.rootCauseSummary || 'Untitled'}</div>
                      <div className="text-xs text-text-muted">{inc.attackerKey || 'unknown'} · {new Date(inc.openedAt).toLocaleDateString()}</div>
                    </div>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      inc.status === 'open' ? 'bg-status-warning/15 text-status-warning' :
                      inc.status === 'triaged' ? 'bg-blue-400/15 text-blue-400' :
                      inc.status === 'contained' ? 'bg-status-healthy/15 text-status-healthy' :
                      'bg-bg-raised text-text-muted'
                    }`}>
                      {inc.status}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
              No incidents — security is clear.
            </div>
          )}
        </div>
      )}

      {tab === 'investigations' && (
        <div className="space-y-4">
          {data?.recentInvestigations?.length ? (
            <div className="bg-bg-surface border border-border-subtle rounded-xl">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary">Recent Investigations</span>
                <Link href="/security/investigations" className="text-xs text-accent hover:underline">
                  View all
                </Link>
              </div>
              <div className="divide-y divide-border-subtle">
                {data.recentInvestigations.map((inv: any) => (
                  <Link
                    key={inv.id}
                    href={`/security/investigations/${inv.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-bg-raised transition-colors"
                  >
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                      inv.severity >= 80 ? 'bg-status-error/15 text-status-error' :
                      inv.severity >= 50 ? 'bg-status-warning/15 text-status-warning' :
                      'bg-bg-raised text-text-muted'
                    }`}>
                      {inv.severity}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary truncate">{inv.name}</div>
                      <div className="text-xs text-text-muted">{inv._count?.incidents ?? 0} incidents · {inv._count?.observables ?? 0} observables</div>
                    </div>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      inv.status === 'open' ? 'bg-status-warning/15 text-status-warning' :
                      inv.status === 'active' ? 'bg-red-400/15 text-red-400' :
                      inv.status === 'resolved' ? 'bg-status-healthy/15 text-status-healthy' :
                      'bg-bg-raised text-text-muted'
                    }`}>
                      {inv.status}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
              No active investigations.
            </div>
          )}
        </div>
      )}

      {tab === 'alerts' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">Recent Alerts</span>
          </div>
          <AlertFeed initialAlerts={data?.recentAlerts} compact />
        </div>
      )}

      {tab === 'approvals' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">Pending Approvals</span>
            <Link href="/security/approvals" className="text-xs text-accent hover:underline">
              Full queue
            </Link>
          </div>
          <div className="divide-y divide-border-subtle">
            {data?.pendingApprovalsList?.length ? data.pendingApprovalsList.slice(0, 5).map((a: any) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <AlertTriangle size={14} className="text-status-warning shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary">{a.actionType}</div>
                  <div className="text-xs text-text-muted truncate">Target: {String(a.target)}</div>
                </div>
                <span className="text-[10px] text-text-muted">{new Date(a.createdAt).toLocaleDateString()}</span>
              </div>
            )) : (
              <div className="px-4 py-8 text-center text-sm text-text-muted">No pending approvals</div>
            )}
          </div>
        </div>
      )}

      {tab === 'flows' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">NetFlow Records</span>
          </div>
          <FlowTable />
        </div>
      )}

      {tab === 'sources' && <SourceHealthPanel />}

      {tab === 'settings' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">Security Settings</span>
          </div>
          <div className="p-4">
            <SecuritySettings />
          </div>
        </div>
      )}
    </div>
  )
}
