'use client'

import { useState, useEffect } from 'react'
import { Shield, AlertTriangle, Activity, Zap, CheckCircle2, Loader2 } from 'lucide-react'
import AlertFeed from './AlertFeed'
import FlowTable from './FlowTable'

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

export default function SecurityDashboard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'alerts' | 'flows'>('overview')

  useEffect(() => {
    fetch('/api/monitoring/security/overview')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Shield size={20} className="text-accent" />
          Security Dashboard
        </h1>
        <div className="flex gap-1 bg-bg-raised rounded-lg p-0.5">
          {(['overview', 'alerts', 'flows'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === t ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <RiskScoreGauge score={data?.riskScore ?? 0} />
            <StatCard icon={AlertTriangle} label="Active Threats" value={data?.activeThreats ?? 0} color="text-status-warning" />
            <StatCard icon={Activity} label="Blocks" value={data?.blockCount ?? 0} color="text-blue-400" />
            <StatCard icon={Zap} label="Anomalies" value={data?.anomalyCount ?? 0} color="text-purple-400" />
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-xl">
            <div className="px-4 py-3 border-b border-border-subtle">
              <span className="text-sm font-medium text-text-primary">Recent Alerts</span>
            </div>
            <AlertFeed initialAlerts={data?.recentAlerts} compact />
          </div>
        </div>
      )}

      {tab === 'alerts' && (
        <div className="bg-bg-surface border border-border-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-medium text-text-primary">All Alerts</span>
          </div>
          <AlertFeed />
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
    </div>
  )
}
