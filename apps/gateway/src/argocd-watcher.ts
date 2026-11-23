/**
 * ArgoCD Sync Watcher
 *
 * Polls ArgoCD Application resources in the cluster every 60s.
 * When sync/health state changes, reports to ORION via OrionClient; otherwise
 * the state is re-sent every REPORT_REFRESH_MS (which also drops removed apps),
 * because ORION's drift detector ignores state reported more than 10 minutes ago.
 *
 * Requires: kubectl in PATH, and a ServiceAccount that may read Applications.
 */

import { run } from './lib/run.js'
import { errMsg, logger } from './lib/logger.js'

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

/**
 * `refresh: true` marks a periodic re-send with no sync/health change: ORION
 * stores it but closes no GitOps PR on it. Must throw when it isn't delivered.
 */
export type SyncReportFn = (apps: ArgoCDApp[], opts?: { refresh?: boolean }) => Promise<void>

/**
 * Re-send after this long: every fourth 60s poll, half a poll early so that a poll
 * running a little short of 4 minutes doesn't wait for the fifth. A failed report
 * is retried on the next poll, so several can fail within the detector's 10 minutes.
 */
export const REPORT_REFRESH_MS = 3.5 * 60_000

export class ArgoCDWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastState: Map<string, string> = new Map() // name → JSON snapshot for change detection
  private lastReportAt = 0

  constructor(
    private readonly onChanged: SyncReportFn,
    private readonly intervalMs = 60_000,
    private readonly refreshMs = REPORT_REFRESH_MS,
  ) {}

  start() {
    // Initial poll immediately, then on interval
    this.poll().catch(err => console.error('[argocd-watcher] Initial poll failed:', errMsg(err)))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[argocd-watcher] Poll failed:', errMsg(err)))
    }, this.intervalMs)
    console.log(`[argocd-watcher] Watching ArgoCD applications (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** One poll (public for tests). */
  async poll() {
    const startedAt = Date.now()
    let stdout: string
    try {
      // maxOutput 0: the JSON is parsed here, so it must not be truncated
      // (maxBuffer still bounds it at 16 MB instead of Node's 1 MB default).
      const result = await run('kubectl', ['get', 'applications', '-n', 'argocd', '-o', 'json'], { timeoutMs: 15_000, maxOutput: 0 })
      stdout = result.stdout
    } catch (err) {
      // ArgoCD may not be installed yet (bootstrapping in progress) — skip quietly,
      // but surface output-size failures, which used to make large clusters go dark.
      const code = (err as { code?: unknown }).code
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        logger.error({ err: String(err) }, '[argocd-watcher] kubectl output exceeded buffer')
      }
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

    const pendingUpdates: Array<{ key: string; snapshot: string }> = []
    for (const app of apps) {
      const key = app.name
      const snapshot = `${app.syncStatus}:${app.healthStatus}:${app.revision}`
      if (this.lastState.get(key) !== snapshot) {
        pendingUpdates.push({ key, snapshot })
        changed.push(app)
      }
    }

    const isFirstPoll = this.lastState.size === 0 && changed.length > 0
    if (changed.length > 0) {
      console.log(`[argocd-watcher] ${isFirstPoll ? 'Initial state' : 'State changed'}: ${changed.map(a => `${a.name}=${a.syncStatus}/${a.healthStatus}`).join(', ')}`)
      // M5 fix: commit state AFTER a successful onChanged so a failed report
      // is retried on the next poll instead of being silently lost.
      await this.onChanged(apps) // send full state, not just changed apps
      for (const { key, snapshot } of pendingUpdates) {
        this.lastState.set(key, snapshot)
      }
      this.lastReportAt = startedAt
    } else if (apps.length > 0 && startedAt - this.lastReportAt >= this.refreshMs) {
      await this.onChanged(apps, { refresh: true })
      this.lastReportAt = startedAt
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
