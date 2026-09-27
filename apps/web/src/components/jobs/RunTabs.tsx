'use client'
import { useMemo } from 'react'
import useSWR from 'swr'
import { RunStatusBadge } from '@/components/ui/Badge'
import { duration, formatDate, thCls, type JobRun } from './job-types'

const SYSTEM_JOBS = [
  { key: 'gitops-drift',        name: 'GitOps Drift Detection', desc: 'Compares cluster state to desired GitOps state',   cadence: 'Every 5 min' },
  { key: 'goal-heartbeat',      name: 'Goal Heartbeat',         desc: 'Re-triggers agents in rooms with stale goals',     cadence: 'Every 5 min' },
  { key: 'security-correlator', name: 'Security Correlator',    desc: 'Correlates security events across sources',        cadence: 'Continuous' },
  { key: 'k8s-poller',          name: 'K8s Security Poller',    desc: 'Polls Kubernetes for security events',             cadence: 'Periodic' },
  { key: 'elk-poller',          name: 'ELK Security Poller',    desc: 'Polls Elasticsearch/Kibana for alerts',            cadence: 'Periodic' },
  { key: 'ntopng-poller',       name: 'ntopng Network Poller',  desc: 'Polls ntopng for network anomalies',               cadence: 'Periodic' },
  { key: 'vuln-scan-daily',     name: 'Daily Vuln Scanner',     desc: 'Scans for new CVEs and vulnerabilities',           cadence: 'Daily at 02:00' },
  { key: 'crowdsec-sync',       name: 'CrowdSec Sync',          desc: 'Syncs CrowdSec ban decisions',                    cadence: 'Periodic' },
  { key: 'audit-export',        name: 'Audit Export',           desc: 'Exports audit logs for compliance',               cadence: 'Daily' },
  { key: 'retention',           name: 'Data Retention',         desc: 'Purges old data per retention policy',            cadence: 'Daily' },
]

const NO_RUNS: JobRun[] = []

export function SystemTab() {
  const { data: runs = NO_RUNS } = useSWR<JobRun[]>('/api/job-runs?source=system&limit=100')
  // Latest run per system job (runs come newest first).
  const lastRuns = useMemo(() => {
    const map: Record<string, JobRun> = {}
    for (const run of runs) if (!map[run.sourceId]) map[run.sourceId] = run
    return map
  }, [runs])

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">System background jobs run automatically by the ORION worker. Runs appear in the History tab.</p>
      <div className="border border-border-subtle rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle"><tr>
            {['Job', 'Description', 'Cadence', 'Last Run', 'Last Status'].map(h => <th key={h} className={thCls}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border-subtle">
            {SYSTEM_JOBS.map(job => {
              const last = lastRuns[job.key]
              return (
                <tr key={job.key} className="hover:bg-bg-raised/50">
                  <td className="px-4 py-3 font-medium text-text-primary whitespace-nowrap">{job.name}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary">{job.desc}</td>
                  <td className="px-4 py-3 text-xs font-mono text-text-muted whitespace-nowrap">{job.cadence}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">{last ? formatDate(last.startedAt) : '—'}</td>
                  <td className="px-4 py-3">{last ? <RunStatusBadge status={last.status} /> : <span className="text-xs text-text-muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SourceBadge({ source }: { source: string }) {
  const cls = source === 'schedule' ? 'bg-blue-500/20 text-blue-400'
    : source === 'webhook' ? 'bg-purple-500/20 text-purple-400'
    : 'bg-gray-500/20 text-gray-400'
  return <span className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${cls}`}>{source}</span>
}

export function HistoryTab() {
  const { data: runs, isLoading } = useSWR<JobRun[]>('/api/job-runs?limit=200')

  if (isLoading && !runs) return <div className="text-sm text-text-muted p-4">Loading…</div>
  if (!runs?.length) return <div className="text-sm text-text-muted py-12 text-center">No job runs recorded yet. Runs will appear here after a schedule, webhook, or system job fires.</div>

  const cell = 'px-3 py-2.5 text-left text-xs font-medium text-text-secondary'
  return (
    <div className="border border-border-subtle rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-raised border-b border-border-subtle"><tr>
          {['Time', 'Source', 'Job', 'Agent', 'Status', 'Duration'].map(h => <th key={h} className={cell}>{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border-subtle">
          {runs.map(run => (
            <tr key={run.id} className="hover:bg-bg-raised/50">
              <td className="px-3 py-2.5 text-xs font-mono text-text-muted whitespace-nowrap">{formatDate(run.startedAt)}</td>
              <td className="px-3 py-2.5"><SourceBadge source={run.source} /></td>
              <td className="px-3 py-2.5 text-sm text-text-primary">{run.sourceName}</td>
              <td className="px-3 py-2.5 text-xs text-text-secondary font-mono">{run.agentId ? run.agentId.slice(0, 8) + '…' : '—'}</td>
              <td className="px-3 py-2.5"><RunStatusBadge status={run.status} />{run.errorMessage && <p className="text-xs text-red-400 mt-0.5 truncate max-w-[200px]" title={run.errorMessage}>{run.errorMessage}</p>}</td>
              <td className="px-3 py-2.5 text-xs font-mono text-text-muted">{duration(run.startedAt, run.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
