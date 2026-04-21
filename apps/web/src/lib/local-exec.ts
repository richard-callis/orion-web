/**
 * Local command runner — falls back to local kubectl/helm when the gateway is unreachable.
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export function makeLocalGx(kubeconfig: string) {
  const tmpDir = `/tmp/orion-kubectl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(`${tmpDir}/kc`, Buffer.from(kubeconfig, 'base64').toString('utf8'), { mode: 0o600 })
  } catch { /* best effort */ }

  const kc = `${tmpDir}/kc`

  return async function kubectlTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'kubectl_apply_manifest' || name === 'kubectl_apply_url') {
      if (name === 'kubectl_apply_url') {
        return (await execFileAsync('kubectl', ['apply', '-f', args.url as string, '--kubeconfig', kc], { timeout: 60_000 })).stdout
      }
      const manifest = String(args.manifest)
      const tmpPath = `${tmpDir}/manifest-${Date.now()}.yaml`
      try {
        writeFileSync(tmpPath, manifest, { mode: 0o600 })
        return (await execFileAsync('kubectl', ['apply', '-f', tmpPath, '--kubeconfig', kc], { timeout: 60_000 })).stdout
      } finally {
        try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
      }
    }

    if (name === 'helm_repo_add' || name === 'helm_upgrade_install' || name === 'helm_uninstall' || name === 'helm_list') {
      let cmd: string[]
      if (name === 'helm_repo_add') {
        cmd = ['repo', 'add', args.name as string, args.url as string]
      } else if (name === 'helm_uninstall') {
        cmd = ['uninstall', args.release as string, '--namespace', args.namespace as string, '--timeout', String(args.timeout ?? '60s'), '--kubeconfig', kc]
      } else if (name === 'helm_list') {
        cmd = ['list', '-o', 'name']
        if (args.namespace) cmd.push('-n', args.namespace as string)
        if (args.filter) cmd.push('--filter', args.filter as string)
      } else {
        const { writeFileSync, unlinkSync } = await import('fs')
        cmd = ['upgrade', '--install', args.release as string, args.chart as string, '--kubeconfig', kc]
        if (args.repo && String(args.repo).startsWith('http')) {
          cmd.push('--repo', args.repo as string)
        }
        cmd.push('--namespace', args.namespace as string, '--timeout', String(args.timeout ?? '120s'))
        if (args.createNamespace) cmd.push('--create-namespace')
        if (args.wait !== false) cmd.push('--wait')
        // Handle valuesFile (YAML string for complex/nested values including arrays)
        if (args.valuesFile) {
          const tmpPath = `${tmpDir}/helm-values-${Date.now()}.yaml`
          writeFileSync(tmpPath, String(args.valuesFile), { mode: 0o600 })
          cmd.push('--values', tmpPath)
          try {
            const result = await execFileAsync('helm', cmd, { timeout: 600_000 })
            return result.stdout
          } finally {
            try { unlinkSync(tmpPath) } catch { /* ignore */ }
          }
        }
        const values = args.values as Record<string, unknown> | undefined
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            cmd.push('--set', `${k}=${v}`)
          }
        }
      }
      try {
        const result = await execFileAsync('helm', cmd, {
          timeout: name === 'helm_upgrade_install' ? 600_000 : name === 'helm_uninstall' ? 60_000 : 30_000,
        })
        return result.stdout
      } catch (e) {
        throw new Error(`helm failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (name === 'kubectl_delete') {
      const resource = (args.resource as string).toLowerCase()
      const cmdArgs = ['delete', resource]
      if (args.name) cmdArgs.push(args.name as string)
      if (args.namespace) cmdArgs.push('-n', args.namespace as string)
      if (args.selector) {
        cmdArgs.push('-l', String(args.selector))
        // --all only works for workload resources, not for pods or services
        if (!args.name && ['deployment', 'statefulset', 'daemonset', 'replicaset', 'job', 'replicationcontroller'].includes(resource)) {
          cmdArgs.push('--all')
        }
      }
      cmdArgs.push('--ignore-not-found=true', '--kubeconfig', kc)
      return (await execFileAsync('kubectl', cmdArgs, { timeout: 30_000 })).stdout
    }

    if (name === 'kubectl_rollout_status') {
      return (await execFileAsync('kubectl', [
        'rollout', 'status', `${args.kind as string}/${args.name as string}`, '-n', args.namespace as string,
        `--timeout=${args.timeout ?? '120s'}`, '--kubeconfig', kc,
      ], { timeout: 300_000 })).stdout
    }

    if (name === 'kubectl_get' || name === 'kubectl_patch' || name === 'kubectl_exec') {
      const cmd = name.startsWith('kubectl_') ? name.substring(8) : 'get'
      const flags: string[] = []
      for (const [k, v] of Object.entries(args).filter(([key]) => key !== 'manifest')) {
        if (k === 'namespace') { flags.push('-n'); flags.push(String(v)) }
        else if (k === 'output') { flags.push(`-o${v === '' ? '' : v}`) }
        else { flags.push(`--${k.replace(/_/g, '-')}`); flags.push(String(v)) }
      }
      return (await execFileAsync('kubectl', [cmd, ...flags, '--kubeconfig', kc], { timeout: 30_000 })).stdout
    }

    return ''
  }
}
