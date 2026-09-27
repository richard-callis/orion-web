'use client'

import { HardDrive } from 'lucide-react'

export function BackupsTab() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-card p-8 text-center space-y-2">
        <HardDrive size={32} className="mx-auto text-text-muted/40" />
        <p className="text-sm font-medium text-text-secondary">Backup monitoring not yet configured</p>
        <p className="text-xs text-text-muted max-w-sm mx-auto">
          Backup status will appear here once the gateway reports backup telemetry
          (TrueNAS rsync, Longhorn snapshots, PVC coverage).
        </p>
      </div>
      <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
        <p className="text-xs font-medium text-text-secondary mb-1">Manual trigger</p>
        <code className="text-xs font-mono text-accent">ansible-playbook playbooks/backup/backup-to-truenas.yml</code>
      </div>
    </div>
  )
}

// ── Logs tab ───────────────────────────────────────────────────────────────────
