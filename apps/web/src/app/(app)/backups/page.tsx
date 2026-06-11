export const dynamic = 'force-dynamic'

import { HardDrive, Server, RotateCcw, Clock } from 'lucide-react'

const PLANNED = [
  { icon: Server, title: 'TrueNAS rsync', description: 'Last sync time, size transferred, and error count for each rsync job.' },
  { icon: HardDrive, title: 'Longhorn snapshots', description: 'Weekly PVC snapshots — coverage, retention policy, and restore links.' },
  { icon: RotateCcw, title: 'Ansible triggers', description: 'Run backup-to-truenas.yml on-demand and stream job output.' },
]

export default function BackupsPage() {
  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Backups</h1>
        <p className="text-sm text-text-muted mt-0.5">Backup status and restore triggers for your cluster.</p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-card p-8 text-center space-y-3">
        <HardDrive size={36} className="mx-auto text-text-muted/40" />
        <p className="text-sm font-medium text-text-secondary">Backup monitoring not yet configured</p>
        <p className="text-xs text-text-muted max-w-xs mx-auto">
          This page will surface backup job status once the ORION gateway reports backup telemetry.
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-xs text-text-muted uppercase tracking-wide font-medium">Planned integrations</p>
        {PLANNED.map(({ icon: Icon, title, description }) => (
          <div key={title} className="flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
            <Icon size={16} className="text-text-muted/60 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-text-secondary">{title}</p>
              <p className="text-xs text-text-muted mt-0.5">{description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Clock size={13} className="text-text-muted" />
          <p className="text-xs font-medium text-text-secondary">Manual trigger</p>
        </div>
        <code className="text-xs font-mono text-accent">
          ansible-playbook playbooks/backup/backup-to-truenas.yml
        </code>
      </div>
    </div>
  )
}
