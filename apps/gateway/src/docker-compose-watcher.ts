/**
 * Docker Compose Sync Watcher
 *
 * Polls Docker container state every 60s; reports changes, and re-sends
 * the state every REPORT_REFRESH_MS (see argocd-watcher.ts).
 * Maps running containers onto the ArgoCDApp shape so the same
 * sync-status API and UI work for Docker environments.
 *
 * Requires: /var/run/docker.sock mounted (already present on docker/localhost gateways).
 */

import { run } from './lib/run.js'
import { errMsg } from './lib/logger.js'
import { REPORT_REFRESH_MS, type ArgoCDApp, type SyncReportFn } from './argocd-watcher.js'

export class DockerComposeWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastState: Map<string, string> = new Map()
  private lastReportAt = 0

  constructor(
    private readonly onChanged: SyncReportFn,
    private readonly intervalMs = 60_000,
    private readonly refreshMs = REPORT_REFRESH_MS,
  ) {}

  start() {
    this.poll().catch(err => console.error('[docker-watcher] Initial poll failed:', errMsg(err)))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[docker-watcher] Poll failed:', errMsg(err)))
    }, this.intervalMs)
    console.log(`[docker-watcher] Watching Docker containers (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** One poll (public for tests). */
  async poll() {
    const startedAt = Date.now()
    try {
      // maxOutput 0: parsed here, must not be truncated (bounded by the 16 MB maxBuffer).
      const result = await run('docker', ['ps', '-a', '--format', 'json'], { timeoutMs: 15_000, maxOutput: 0 })

      const lines = result.stdout.trim().split('\n').filter(Boolean)
      const containers = lines.map(line => JSON.parse(line))
      const completed = await completedOneShots(containers)
      const apps: ArgoCDApp[] = containers.map(c => parseContainer(c, completed))

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
        this.lastReportAt = startedAt
      } else if (apps.length > 0 && startedAt - this.lastReportAt >= this.refreshMs) {
        await this.onChanged(apps, { refresh: true })
        this.lastReportAt = startedAt
      }
    } catch (err) {
      console.error('[docker-watcher] Poll failed:', err instanceof Error ? err.message : String(err))
    }
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * IDs of containers treated as finished, not down: exited 0 under restart policy
 * `no` or `on-failure`, i.e. nothing was meant to bring them back. That is how
 * init jobs look, but also a service run without a restart policy (Docker's
 * default) and stopped cleanly: Docker can't tell the two apart, and flagging
 * every init job forever is worse. A service with always/unless-stopped is still
 * reported as down. If Docker can't be asked, none count as finished.
 */
async function completedOneShots(containers: Array<{ ID?: string; State?: string; Status?: string }>): Promise<Set<string>> {
  const ids = containers
    .filter(c => (c.State ?? '').toLowerCase() === 'exited' && /^Exited \(0\)/.test(c.Status ?? ''))
    .map(c => c.ID ?? '')
    .filter(id => /^[0-9a-f]{12,64}$/.test(id))
  if (ids.length === 0) return new Set()
  let stdout: string
  try {
    ;({ stdout } = await run('docker', ['inspect', '--type', 'container', '--format', '{{.Id}} {{.HostConfig.RestartPolicy.Name}}', ...ids], { timeoutMs: 15_000, maxOutput: 0 }))
  } catch (err) {
    // A container removed since `docker ps` fails the whole command, after it
    // printed the others.
    stdout = (err as { stdout?: string }).stdout ?? ''
    console.error('[docker-watcher] docker inspect failed:', err instanceof Error ? err.message : String(err))
  }
  const done = stdout.split('\n').map(l => l.trim().split(' ')).filter(([, policy]) => policy === 'no' || policy === 'on-failure')
  return new Set(ids.filter(id => done.some(([full]) => full.startsWith(id))))
}

function parseContainer(c: unknown, completed: Set<string>): ArgoCDApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = c as any
  const labels = d.Labels ?? {}
  const projectName = labels['com.docker.compose.project'] ?? 'docker'

  const name = (d.Names ?? 'unknown').replace(/^\//, '')
  const state = (d.State ?? '').toLowerCase()
  const status = (d.Status ?? '')
  const image = d.Image ?? ''

  const finished = completed.has(d.ID ?? '')

  let syncStatus: ArgoCDApp['syncStatus']
  if (state === 'running' || finished) {
    syncStatus = 'Synced'
  } else if (state === 'exited' || state === 'restarting') {
    syncStatus = 'OutOfSync'
  } else {
    syncStatus = 'Unknown'
  }

  let healthStatus: ArgoCDApp['healthStatus']
  if (finished || (state === 'running' && !status.includes('health: starting'))) {
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
