/**
 * ArgoCD Sync Watcher
 *
 * Polls ArgoCD Application resources in the cluster every 60s.
 * When sync/health state changes, reports to ORION via OrionClient.
 *
 * Requires: kubectl in PATH, cluster-admin ServiceAccount (provided by bootstrap).
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface ArgoCDApp {
  name: string
  namespace: string
  project: string
  syncStatus: 'Synced' | 'OutOfSync' | 'Unknown'
  healthStatus: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown'
  revision: string
  message: string
  reconciledAt: string | null
}

type SyncReportFn = (apps: ArgoCDApp[]) => Promise<void>

export class ArgoCDWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastState: Map<string, string> = new Map() // name → JSON snapshot for change detection

  constructor(
    private readonly onChanged: SyncReportFn,
    private readonly intervalMs = 60_000,
  ) {}

  start() {
    // Initial poll immediately, then on interval
    this.poll().catch(err => console.error('[argocd-watcher] Initial poll failed:', err))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[argocd-watcher] Poll failed:', err))
    }, this.intervalMs)
    console.log(`[argocd-watcher] Watching ArgoCD applications (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async poll() {
    let stdout: string
    try {
      const result = await execAsync(
        'kubectl get applications -n argocd -o json 2>/dev/null',
        { timeout: 15_000 },
      )
      stdout = result.stdout
    } catch {
      // ArgoCD may not be installed yet (bootstrapping in progress) — silent skip
      return
    }

    let list: { items?: unknown[] }
    try {
      list = JSON.parse(stdout)
    } catch {
      console.error('[argocd-watcher] Failed to parse kubectl output')
      return
    }

    const items = list.items ?? []
    const apps: ArgoCDApp[] = items.map((item: unknown) => parseApp(item))
    const changed: ArgoCDApp[] = []

    for (const app of apps) {
      const key = app.name
      const snapshot = `${app.syncStatus}:${app.healthStatus}:${app.revision}`
      if (this.lastState.get(key) !== snapshot) {
        this.lastState.set(key, snapshot)
        changed.push(app)
      }
    }

    // Always report on first poll (lastState is empty); subsequent polls only on change
    const isFirstPoll = this.lastState.size === apps.length && changed.length === apps.length
    if (changed.length > 0) {
      console.log(`[argocd-watcher] ${isFirstPoll ? 'Initial state' : 'State changed'}: ${changed.map(a => `${a.name}=${a.syncStatus}/${a.healthStatus}`).join(', ')}`)
      await this.onChanged(apps) // send full state, not just changed apps
    }
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseApp(item: unknown): ArgoCDApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = item as any
  const status = a?.status ?? {}
  const sync = status?.sync ?? {}
  const health = status?.health ?? {}
  const conditions = (status?.conditions ?? []) as Array<{ message?: string }>
  const message = conditions.map((c) => c.message ?? '').filter(Boolean).join('; ')

  return {
    name:          a?.metadata?.name ?? 'unknown',
    namespace:     a?.metadata?.namespace ?? 'argocd',
    project:       a?.spec?.project ?? 'default',
    syncStatus:    sync?.status ?? 'Unknown',
    healthStatus:  health?.status ?? 'Unknown',
    revision:      sync?.revision ?? '',
    message,
    reconciledAt:  status?.reconciledAt ?? null,
  }
}
