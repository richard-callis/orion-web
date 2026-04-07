export const dynamic = 'force-dynamic'

export default function BackupsPage() {
  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="rounded-lg border border-border-subtle bg-bg-card p-6 text-center text-text-muted">
        <p className="text-sm">Backup status coming soon.</p>
        <p className="text-xs mt-2">Will show: TrueNAS last rsync, Longhorn weekly snapshots, PVC coverage.</p>
        <p className="text-xs mt-1">Trigger: <code className="font-mono text-accent">ansible-playbook playbooks/backup/backup-to-truenas.yml</code></p>
      </div>
    </div>
  )
}
