/**
 * Docker Compose Sync Watcher
 *
 * Polls Docker container state every 60s.
 * Maps running containers onto the ArgoCDApp shape so the same
 * sync-status API and UI work for Docker environments.
 *
 * Requires: /var/run/docker.sock mounted (already present on docker/localhost gateways).
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { ArgoCDApp } from './argocd-watcher.js'

const execAsync = promisify(exec)

type SyncReportFn = (apps: ArgoCDApp[]) => Promise<void>

export class DockerComposeWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastState: Map<string, string> = new Map()

  constructor(
    private readonly onChanged: SyncReportFn,
    private readonly intervalMs = 60_000,
  ) {}

  start() {
    this.poll().catch(err => console.error('[docker-watcher] Initial poll failed:', err))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[docker-watcher] Poll failed:', err))
    }, this.intervalMs)
    console.log(`[docker-watcher] Watching Docker containers (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async poll() {
    try {
      const result = await execAsync(
        'docker ps -a --format json 2>/dev/null',
        { timeout: 15_000 },
      )

      const lines = result.stdout.trim().split('\n').filter(Boolean)
      const containers = lines.map(line => JSON.parse(line))
      const apps: ArgoCDApp[] = containers.map(parseContainer)

      const newSnapshots = new Map<string, string>()
      let hasChanges = false
      for (const app of apps) {
        const snapshot = `${app.syncStatus}:${app.healthStatus}:${app.revision}`
        newSnapshots.set(app.name, snapshot)
        if (this.lastState.get(app.name) !== snapshot) hasChanges = true
      }

      if (hasChanges || this.lastState.size === 0) {
        console.log(`[docker-watcher] State changed: ${apps.map(a => `${a.name}=${a.syncStatus}/${a.healthStatus}`).join(', ')}`)
        await this.onChanged(apps)
        // Only commit lastState after successful report
        this.lastState = newSnapshots
      }
    } catch (err) {
      console.error('[docker-watcher] Poll failed:', err instanceof Error ? err.message : String(err))
    }
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseContainer(c: unknown): ArgoCDApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = c as any
  const labels = d.Labels ?? {}
  const projectName = labels['com.docker.compose.project'] ?? 'docker'

  const name = (d.Names ?? 'unknown').replace(/^\//, '')
  const state = (d.State ?? '').toLowerCase()
  const status = (d.Status ?? '')
  const image = d.Image ?? ''

  let syncStatus: ArgoCDApp['syncStatus']
  if (state === 'running') {
    syncStatus = 'Synced'
  } else if (state === 'exited' || state === 'restarting') {
    syncStatus = 'OutOfSync'
  } else {
    syncStatus = 'Unknown'
  }

  let healthStatus: ArgoCDApp['healthStatus']
  if (state === 'running' && !status.includes('health: starting')) {
    healthStatus = 'Healthy'
  } else if (state === 'running' && status.includes('health: starting')) {
    healthStatus = 'Progressing'
  } else if (state === 'exited' || state === 'restarting' || state === 'dead') {
    healthStatus = 'Degraded'
  } else {
    healthStatus = 'Unknown'
  }

  return {
    name:         name,
    namespace:    'docker',
    project:      projectName,
    syncStatus,
    healthStatus,
    revision:     image,
    message:      status,
    reconciledAt: new Date().toISOString(),
  }
}
