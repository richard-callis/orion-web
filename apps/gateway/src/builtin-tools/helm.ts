/**
 * Helm upgrade manager tools for ORION Gateway.
 *
 * Provides full release lifecycle management: list, inspect, diff, upgrade
 * (with automatic rollback on failure), rollback, and value inspection.
 * Uses the `helm` CLI directly — matches the existing kubernetes.ts pattern.
 *
 * Registered for GATEWAY_TYPE=cluster and GATEWAY_TYPE=localhost.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

const exec = promisify(execFile)

async function helm(args: string[], timeoutMs = 300_000): Promise<string> {
  const { stdout, stderr } = await exec('helm', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  return stdout || stderr
}

export const helmTools = ([
  {
    name: 'helm_list',
    description: 'List installed Helm releases with chart version, app version, status, and last deployed time',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list releases in (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      try {
        const cmdArgs = ['list', '-o', 'json']
        if (args.namespace) cmdArgs.push('-n', String(args.namespace))
        else cmdArgs.push('-A')
        const raw = await helm(cmdArgs, 30_000)
        const releases = JSON.parse(raw) as Array<{
          name: string
          namespace: string
          revision: string
          updated: string
          status: string
          chart: string
          app_version: string
        }>
        if (releases.length === 0) return 'No Helm releases found'
        const lines = [`Found ${releases.length} release(s):\n`]
        for (const r of releases) {
          lines.push(`  ${r.namespace}/${r.name}`)
          lines.push(`    Chart:      ${r.chart}`)
          lines.push(`    AppVersion: ${r.app_version || 'n/a'}`)
          lines.push(`    Status:     ${r.status}`)
          lines.push(`    Revision:   ${r.revision}`)
          lines.push(`    Updated:    ${r.updated}`)
          lines.push('')
        }
        return lines.join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'helm_history',
    description: 'Show revision history for a Helm release, including status and chart version for each revision',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the release' },
        release:   { type: 'string', description: 'Release name' },
      },
      required: ['namespace', 'release'],
    },
    async execute(args: Record<string, unknown>) {
      try {
        const raw = await helm([
          'history', String(args.release),
          '-n', String(args.namespace),
          '-o', 'json',
        ], 30_000)
        const history = JSON.parse(raw) as Array<{
          revision: number
          updated: string
          status: string
          chart: string
          app_version: string
          description: string
        }>
        if (history.length === 0) return `No history found for release ${args.namespace}/${args.release}`
        const lines = [`Revision history for ${args.namespace}/${args.release} (${history.length} revisions):\n`]
        for (const h of history) {
          lines.push(`  Rev ${h.revision}: ${h.status}`)
          lines.push(`    Chart:       ${h.chart}`)
          lines.push(`    AppVersion:  ${h.app_version || 'n/a'}`)
          lines.push(`    Updated:     ${h.updated}`)
          lines.push(`    Description: ${h.description || 'n/a'}`)
          lines.push('')
        }
        return lines.join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'helm_diff',
    description: 'Preview changes before upgrading a Helm release. Uses `helm diff upgrade` if the plugin is installed, otherwise falls back to a `helm template` diff against the currently deployed manifest',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the release' },
        release:   { type: 'string', description: 'Release name' },
        chartRef:  { type: 'string', description: 'Chart reference, e.g. bitnami/nginx or https://charts.bitnami.com/bitnami/nginx-1.2.3.tgz' },
        version:   { type: 'string', description: 'Chart version to diff against (omit for latest)' },
        values:    { type: 'object', description: 'Values to apply for the diff (key: value pairs)' },
      },
      required: ['namespace', 'release', 'chartRef'],
    },
    async execute(args: Record<string, unknown>) {
      const ns = String(args.namespace)
      const release = String(args.release)
      const chartRef = String(args.chartRef)

      try {
        // Try helm diff upgrade first (requires helm-diff plugin)
        const diffArgs = ['diff', 'upgrade', release, chartRef, '-n', ns, '--no-hooks']
        if (args.version) diffArgs.push('--version', String(args.version))
        const values = args.values as Record<string, unknown> | undefined
        if (values) {
          for (const [k, v] of Object.entries(values)) diffArgs.push('--set', `${k}=${v}`)
        }
        try {
          const diffOut = await helm(diffArgs, 120_000)
          if (diffOut.trim()) return `Helm diff for ${ns}/${release} → ${chartRef}:\n\n${diffOut}`
          return `No changes detected for ${ns}/${release} → ${chartRef} (diff is empty)`
        } catch (diffErr) {
          const msg = diffErr instanceof Error ? diffErr.message : String(diffErr)
          // If helm-diff plugin is not installed, fall through to template diff
          if (!msg.includes('unknown command') && !msg.includes('not found') && !msg.includes('no such sub')) {
            throw diffErr
          }
        }

        // Fallback: helm template diff
        // Get current manifest via helm get manifest
        const currentManifest = await helm(['get', 'manifest', release, '-n', ns], 30_000).catch(() => '')

        // Render the new template
        const newArgs = ['template', release, chartRef, '-n', ns]
        if (args.version) newArgs.push('--version', String(args.version))
        if (values) {
          for (const [k, v] of Object.entries(values)) newArgs.push('--set', `${k}=${v}`)
        }
        const newManifest = await helm(newArgs, 60_000)

        if (currentManifest.trim() === newManifest.trim()) {
          return `No changes detected for ${ns}/${release} → ${chartRef} (template diff is empty)`
        }

        // Write both to temp files and diff them
        const tmpCurrent = `/tmp/orion-helm-current-${randomUUID()}.yaml`
        const tmpNew = `/tmp/orion-helm-new-${randomUUID()}.yaml`
        writeFileSync(tmpCurrent, currentManifest, 'utf8')
        writeFileSync(tmpNew, newManifest, 'utf8')
        try {
          const { stdout: diffOutput } = await exec('diff', ['-u', tmpCurrent, tmpNew], { timeout: 10_000 }).catch((e: unknown) => {
            // diff exits 1 when files differ — that's normal
            const err = e as { stdout?: string; code?: number }
            if (err.code === 1 && err.stdout) return { stdout: err.stdout }
            throw e
          })
          return `Helm template diff for ${ns}/${release} → ${chartRef} (helm-diff plugin not available, showing template diff):\n\n${diffOutput || '(no differences found)'}`
        } finally {
          try { unlinkSync(tmpCurrent) } catch { /* ignore */ }
          try { unlinkSync(tmpNew) } catch { /* ignore */ }
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'helm_upgrade',
    description: 'Upgrade (or install) a Helm release. On failure, automatically runs helm rollback to the previous revision and reports the error',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace for the release' },
        release:   { type: 'string', description: 'Release name' },
        chartRef:  { type: 'string', description: 'Chart reference, e.g. bitnami/nginx or oci://registry/chart' },
        version:   { type: 'string', description: 'Chart version to upgrade to (omit for latest)' },
        values:    { type: 'object', description: 'Values to override (key: value pairs). For complex/nested values use valuesYaml.' },
        valuesYaml: { type: 'string', description: 'Full YAML values string (used for arrays and nested structures; merged with values)' },
        createNamespace: { type: 'boolean', description: 'Create the namespace if it does not exist (default false)' },
        wait:      { type: 'boolean', description: 'Wait for all pods to be ready (default true)' },
        timeout:   { type: 'string', description: 'Upgrade timeout, e.g. 120s, 10m (default 120s)' },
        atomic:    { type: 'boolean', description: 'If set, rolls back automatically on failure (equivalent to --atomic); overrides the built-in rollback logic' },
      },
      required: ['namespace', 'release', 'chartRef'],
    },
    async execute(args: Record<string, unknown>) {
      const ns = String(args.namespace)
      const release = String(args.release)
      const chartRef = String(args.chartRef)
      const timeout = String(args.timeout ?? '120s')

      const cmdArgs = [
        'upgrade', '--install', release, chartRef,
        '-n', ns,
        '--timeout', timeout,
      ]
      if (args.version) cmdArgs.push('--version', String(args.version))
      if (args.createNamespace) cmdArgs.push('--create-namespace')
      if (args.wait !== false) cmdArgs.push('--wait')
      if (args.atomic) cmdArgs.push('--atomic')

      // Parse timeout to determine exec timeout
      const timeoutSecs = timeout.endsWith('m')
        ? parseInt(timeout) * 60
        : parseInt(timeout)
      const execMs = (timeoutSecs + 30) * 1_000

      // Handle values file (takes priority for complex/nested values)
      let tmpValuesFile: string | null = null
      if (args.valuesYaml) {
        tmpValuesFile = `/tmp/orion-helm-values-${randomUUID()}.yaml`
        writeFileSync(tmpValuesFile, String(args.valuesYaml), 'utf8')
        cmdArgs.push('--values', tmpValuesFile)
      }

      // Handle inline key=value overrides
      const values = args.values as Record<string, unknown> | undefined
      if (values) {
        for (const [k, v] of Object.entries(values)) cmdArgs.push('--set', `${k}=${v}`)
      }

      try {
        const out = await helm(cmdArgs, execMs)
        return `Helm upgrade successful for ${ns}/${release}:\n${out}`
      } catch (upgradeErr) {
        const upgradeMsg = upgradeErr instanceof Error ? upgradeErr.message : String(upgradeErr)

        // Don't double-rollback if --atomic was used (helm already rolled back)
        if (args.atomic) {
          return `Helm upgrade failed for ${ns}/${release} (--atomic rolled back automatically):\n${upgradeMsg}`
        }

        // Automatic rollback on failure
        let rollbackMsg = ''
        try {
          const rbOut = await helm(['rollback', release, '-n', ns, '--wait', '--timeout', '60s'], 90_000)
          rollbackMsg = `\nAuto-rollback succeeded:\n${rbOut}`
        } catch (rbErr) {
          rollbackMsg = `\nAuto-rollback also failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`
        }
        return `Helm upgrade FAILED for ${ns}/${release}:\n${upgradeMsg}${rollbackMsg}`
      } finally {
        if (tmpValuesFile) { try { unlinkSync(tmpValuesFile) } catch { /* ignore */ } }
      }
    },
  },

  {
    name: 'helm_rollback',
    description: 'Roll back a Helm release to the previous revision or a specific revision number',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the release' },
        release:   { type: 'string', description: 'Release name' },
        revision:  { type: 'number', description: 'Target revision number (omit to roll back to the previous revision)' },
        wait:      { type: 'boolean', description: 'Wait for pods to be ready after rollback (default true)' },
        timeout:   { type: 'string', description: 'Timeout, e.g. 120s (default 120s)' },
      },
      required: ['namespace', 'release'],
    },
    async execute(args: Record<string, unknown>) {
      try {
        const cmdArgs = ['rollback', String(args.release), '-n', String(args.namespace)]
        if (args.revision != null) cmdArgs.push(String(Math.floor(Number(args.revision))))
        if (args.wait !== false) cmdArgs.push('--wait')
        cmdArgs.push('--timeout', String(args.timeout ?? '120s'))
        const out = await helm(cmdArgs, 180_000)
        const target = args.revision != null ? `revision ${args.revision}` : 'previous revision'
        return `Rolled back ${args.namespace}/${args.release} to ${target}:\n${out}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'helm_get_values',
    description: 'Get the current values for an installed Helm release (user-supplied overrides only, not chart defaults)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the release' },
        release:   { type: 'string', description: 'Release name' },
        all:       { type: 'boolean', description: 'Include computed defaults as well as user-supplied values (helm get values --all)' },
      },
      required: ['namespace', 'release'],
    },
    async execute(args: Record<string, unknown>) {
      try {
        const cmdArgs = ['get', 'values', String(args.release), '-n', String(args.namespace)]
        if (args.all) cmdArgs.push('--all')
        const out = await helm(cmdArgs, 30_000)
        return out.trim() || `No user-supplied values found for ${args.namespace}/${args.release} (chart defaults are in use)`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },
] as const).map(t => ({ ...t, category: 'cluster-ops' as const }))
