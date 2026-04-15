/**
 * Ingress Watcher
 *
 * Polls K8s Ingress resources every 60s.
 * On any change reports the full set of ingress rules to ORION so they
 * appear in the Ingress management page.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface K8sIngressRule {
  host: string
  paths: string[]
  tls: boolean
  namespace: string
  ingressName: string
}

type ReportFn = (ingresses: K8sIngressRule[]) => Promise<void>

export class IngressWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastSnapshot = ''

  constructor(
    private readonly onChanged: ReportFn,
    private readonly intervalMs = 60_000,
  ) {}

  start() {
    this.poll().catch(err => console.error('[ingress-watcher] Initial poll failed:', err))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[ingress-watcher] Poll failed:', err))
    }, this.intervalMs)
    console.log(`[ingress-watcher] Watching Ingress resources (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async poll() {
    let stdout: string
    try {
      const result = await execAsync(
        'kubectl get ingress -A -o json 2>/dev/null',
        { timeout: 15_000 },
      )
      stdout = result.stdout
    } catch {
      // Ingress API may not be available yet — silent skip
      return
    }

    let list: { items?: unknown[] }
    try {
      list = JSON.parse(stdout)
    } catch {
      console.error('[ingress-watcher] Failed to parse kubectl output')
      return
    }

    const items = list.items ?? []
    const rules: K8sIngressRule[] = []

    for (const item of items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = item as any
      const namespace   = obj?.metadata?.namespace ?? 'default'
      const ingressName = obj?.metadata?.name ?? 'unknown'
      const tlsHosts    = new Set<string>(
        (obj?.spec?.tls ?? []).flatMap((t: { hosts?: string[] }) => t.hosts ?? [])
      )

      for (const rule of obj?.spec?.rules ?? []) {
        const host = (rule?.host ?? '').toLowerCase()
        if (!host) continue
        const paths: string[] = (rule?.http?.paths ?? []).map(
          (p: { path?: string }) => p.path ?? '/'
        )
        rules.push({
          host,
          paths: paths.length > 0 ? paths : ['/'],
          tls:   tlsHosts.has(host),
          namespace,
          ingressName,
        })
      }
    }

    // Only report when something changed
    const snapshot = JSON.stringify(rules.map(r => `${r.host}:${r.paths.join(',')}`).sort())
    if (snapshot === this.lastSnapshot) return
    this.lastSnapshot = snapshot

    const isFirst = this.lastSnapshot === snapshot && rules.length > 0
    console.log(`[ingress-watcher] ${isFirst ? 'Initial' : 'Changed'}: ${rules.length} ingress rule(s)`)
    await this.onChanged(rules)
  }
}
