import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { runOut } from '../lib/run.js'
import { safeFetch } from '../lib/ssrf.js'
import {
  withValidation, noFlag, k8sName, k8sLabel, k8sNamespace, k8sResource, labelSelector,
  oneOf, duration, durationSeconds, positiveInt, helmName, httpUrl,
} from '../lib/validate-args.js'

// Every agent-supplied value goes through validate-args before reaching argv, and
// positionals follow a `--` terminator: a value such as `--server=https://attacker`
// must never become a kubectl/helm flag (it would redirect the service-account token).

async function kubectl(args: string[], timeoutMs = 30_000, input?: string): Promise<string> {
  return runOut('kubectl', args, { timeoutMs, input })
}

/** Untruncated output (still bounded by maxBuffer) for JSON the tool parses itself. */
async function kubectlJson(args: string[], timeoutMs = 30_000): Promise<string> {
  return runOut('kubectl', args, { timeoutMs, maxOutput: 0 })
}

async function helm(args: string[], timeoutMs = 300_000): Promise<string> {
  return runOut('helm', args, { timeoutMs })
}

const ROLLOUT_KINDS = ['deployment', 'statefulset', 'daemonset'] as const
const GET_OUTPUTS = ['wide', 'json', 'yaml', 'name'] as const
const MANIFEST_MAX_BYTES = 10 * 1024 * 1024

/**
 * Read-only diagnostic binaries allowed in kubectl_exec. Deliberately excludes
 * find (-exec runs arbitrary commands), curl/wget/nc (network pivot and cloud
 * metadata access) and env/printenv (dumps pod secrets).
 */
const EXEC_ALLOWED = new Set(['nslookup', 'dig', 'ping', 'cat', 'ls', 'ps', 'df', 'free', 'uptime', 'id', 'uname', 'hostname', 'head', 'tail', 'grep'])

export const kubernetesTools = ([
  {
    name: 'kubectl_get_pods',
    description: 'List pods in a namespace (or all namespaces)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list pods in (omit for all namespaces)' },
        selector:  { type: 'string', description: 'Label selector, e.g. app=nginx' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const cmdArgs = ['get', 'pods', '-o', 'wide']
        if (args.namespace) cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        else cmdArgs.push('-A')
        if (args.selector) cmdArgs.push('-l', labelSelector('selector', args.selector))
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_get_nodes',
    description: 'List cluster nodes with status and roles',
    inputSchema: {
      type: 'object',
      properties: {
        wide: { type: 'boolean', description: 'Show extra columns including IPs' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return kubectl(['get', 'nodes', ...(args.wide ? ['-o', 'wide'] : [])])
    },
  },
  {
    name: 'kubectl_logs',
    description: 'Get logs from a pod',
    inputSchema: {
      type: 'object',
      properties: {
        pod:       { type: 'string', description: 'Pod name' },
        namespace: { type: 'string', description: 'Namespace' },
        container: { type: 'string', description: 'Container name (if multi-container pod)' },
        tail:      { type: 'number', description: 'Number of lines from end (default 100)' },
        previous:  { type: 'boolean', description: 'Get logs from previous (crashed) container' },
      },
      required: ['pod', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const tail = args.tail === undefined ? 100 : positiveInt('tail', args.tail)
        const cmdArgs = ['logs', '-n', k8sNamespace('namespace', args.namespace), `--tail=${tail}`]
        if (args.container) cmdArgs.push('-c', k8sLabel('container', args.container))
        if (args.previous) cmdArgs.push('--previous')
        cmdArgs.push('--', k8sName('pod', args.pod))
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_describe',
    description: 'Describe a Kubernetes resource',
    inputSchema: {
      type: 'object',
      properties: {
        resource:  { type: 'string', description: 'Resource type, e.g. pod, deployment, service, node' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace (for namespaced resources)' },
      },
      required: ['resource', 'name'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const cmdArgs = ['describe']
        if (args.namespace) cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        cmdArgs.push('--', k8sResource('resource', args.resource), k8sName('name', args.name))
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_delete',
    description: 'Delete a Kubernetes resource (kubectl delete)',
    inputSchema: {
      type: 'object',
      properties: {
        resource:  { type: 'string', description: 'Resource type, e.g. pod, deployment, service, deploymentconfig' },
        name:      { type: 'string', description: 'Resource name (omit to delete by selector/file)' },
        namespace: { type: 'string', description: 'Namespace (for namespaced resources)' },
        selector:  { type: 'string', description: 'Label selector (e.g. app=nginx) — use instead of name to delete multiple resources' },
        ignoreNotFound: { type: 'boolean', description: 'Ignore if resource not found (default true)' },
      },
      required: ['resource'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const resource = k8sResource('resource', args.resource).toLowerCase()
        const cmdArgs = ['delete']
        if (args.namespace) cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        if (args.selector) {
          cmdArgs.push('-l', labelSelector('selector', args.selector))
          // --all only works for workload resources, not for pods or services
          if (!args.name && ['deployment', 'statefulset', 'daemonset', 'replicaset', 'job', 'replicationcontroller'].includes(resource)) {
            cmdArgs.push('--all')
          }
        }
        if (args.ignoreNotFound !== false) cmdArgs.push('--ignore-not-found=true')
        cmdArgs.push('--', resource)
        if (args.name) cmdArgs.push(k8sName('name', args.name))
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_get',
    description: 'Get any Kubernetes resource in JSON or YAML format',
    inputSchema: {
      type: 'object',
      properties: {
        resource:  { type: 'string', description: 'Resource type, e.g. deployment, service, ingress' },
        name:      { type: 'string', description: 'Resource name (omit to list all)' },
        namespace: { type: 'string', description: 'Namespace (omit for all namespaces)' },
        output:    { type: 'string', enum: ['wide', 'json', 'yaml', 'name'], description: 'Output format' },
      },
      required: ['resource'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const resource = k8sResource('resource', args.resource)
        const name = args.name ? k8sName('name', args.name) : undefined
        const cmdArgs = ['get']
        if (args.namespace) {
          cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        } else if (!name) {
          // Only add -A for namespaced resources — cluster-scoped resources (nodes, pv,
          // clusterrole, namespace, etc.) error or return nothing with -A.
          const clusterScoped = ['node', 'nodes', 'persistentvolume', 'pv', 'storageclass',
            'clusterrole', 'clusterrolebinding', 'namespace', 'ns', 'ingressclass',
            'priorityclass', 'runtimeclass', 'crd', 'customresourcedefinition']
          if (!clusterScoped.includes(resource.toLowerCase())) {
            cmdArgs.push('-A')
          }
        }
        cmdArgs.push('-o', oneOf('output', args.output ?? 'wide', GET_OUTPUTS))
        cmdArgs.push('--', resource)
        if (name) cmdArgs.push(name)
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_rollout_restart',
    description: 'Restart a deployment, statefulset, or daemonset',
    inputSchema: {
      type: 'object',
      properties: {
        kind:      { type: 'string', enum: ['deployment', 'statefulset', 'daemonset'], description: 'Resource kind' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace' },
      },
      required: ['kind', 'name', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const kind = oneOf('kind', args.kind, ROLLOUT_KINDS)
        return kubectl(['rollout', 'restart', '-n', k8sNamespace('namespace', args.namespace), '--', `${kind}/${k8sName('name', args.name)}`])
      })
    },
  },
  {
    name: 'kubectl_top_pods',
    description: 'Show CPU and memory usage for pods',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const cmdArgs = ['top', 'pods']
        if (args.namespace) cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        else cmdArgs.push('-A')
        return kubectl(cmdArgs)
      })
    },
  },
  {
    name: 'kubectl_apply_url',
    description: 'Apply a Kubernetes manifest from a URL (kubectl apply -f <url>)',
    inputSchema: {
      type: 'object',
      properties: {
        url:       { type: 'string', description: 'URL of the manifest to apply' },
        namespace: { type: 'string', description: 'Namespace (optional)' },
      },
      required: ['url'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        // N9/M4 fix: kubectl used to fetch the URL itself after a regex-only hostname
        // check (no DNS resolution, no IPv6, redirects followed). The manifest is now
        // downloaded via safeFetch — which pins the validated IP and re-validates every
        // redirect hop — and piped to `kubectl apply -f -`.
        const namespace = args.namespace ? k8sNamespace('namespace', args.namespace) : undefined
        let res
        try {
          res = await safeFetch(String(args.url ?? ''), { timeoutMs: 60_000, maxBytes: MANIFEST_MAX_BYTES, onOverflow: 'error' })
        } catch (err) {
          return `Error: could not download manifest: ${err instanceof Error ? err.message : String(err)}`
        }
        if (res.status < 200 || res.status >= 300) return `Error: manifest download returned HTTP ${res.status}`
        const cmdArgs = ['apply', '-f', '-']
        if (namespace) cmdArgs.push('-n', namespace)
        return kubectl(cmdArgs, 120_000, res.body)
      })
    },
  },
  {
    name: 'kubectl_apply_manifest',
    description: 'Apply a Kubernetes manifest from a YAML string (kubectl apply -f -)',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'string', description: 'YAML manifest content to apply' },
      },
      required: ['manifest'],
    },
    async execute(args: Record<string, unknown>) {
      return kubectl(['apply', '-f', '-'], 60_000, String(args.manifest ?? ''))
    },
  },
  {
    name: 'kubectl_patch',
    description: 'Patch a Kubernetes resource (kubectl patch)',
    inputSchema: {
      type: 'object',
      properties: {
        resource:  { type: 'string', description: 'Resource type, e.g. storageclass, deployment' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace (omit for cluster-scoped resources)' },
        patch:     { type: 'string', description: 'JSON patch string' },
        patchType: { type: 'string', description: 'Patch type: merge, json, or strategic (default: merge)' },
      },
      required: ['resource', 'name', 'patch'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const patchType = String(args.patchType ?? 'merge')
        const typeFlag = patchType === 'json' ? 'json' : patchType === 'strategic' ? 'strategic' : 'merge'
        const cmd = ['patch', `--type=${typeFlag}`, `--patch=${String(args.patch ?? '')}`]
        if (args.namespace) cmd.push('-n', k8sNamespace('namespace', args.namespace))
        cmd.push('--', k8sResource('resource', args.resource), k8sName('name', args.name))
        return kubectl(cmd)
      })
    },
  },
  {
    name: 'kubectl_rollout_status',
    description: 'Wait for a rollout to complete',
    inputSchema: {
      type: 'object',
      properties: {
        kind:      { type: 'string', enum: ['deployment', 'statefulset', 'daemonset'], description: 'Resource kind' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace' },
        timeout:   { type: 'string', description: 'Timeout (default 120s)' },
      },
      required: ['kind', 'name', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        // Parse the kubectl --timeout value and add 5s buffer for the Node exec timeout
        const ktimeout = duration('timeout', args.timeout ?? '120s')
        const execMs   = (durationSeconds(ktimeout) + 5) * 1_000
        const kind = oneOf('kind', args.kind, ROLLOUT_KINDS)
        return kubectl([
          'rollout', 'status',
          '-n', k8sNamespace('namespace', args.namespace),
          `--timeout=${ktimeout}`,
          '--', `${kind}/${k8sName('name', args.name)}`,
        ], execMs)
      })
    },
  },
  {
    name: 'kubectl_exec',
    description: 'Execute a read-only diagnostic command inside a running pod. Allowed commands: nslookup, dig, ping, cat, ls, ps, df, free, uptime, id, uname, hostname, head, tail, grep.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the pod' },
        pod:       { type: 'string', description: 'Pod name' },
        container: { type: 'string', description: 'Container name (omit for default)' },
        command:   { type: 'array', items: { type: 'string' }, description: 'Command and args, e.g. ["nslookup", "my-svc.default"]' },
      },
      required: ['namespace', 'pod', 'command'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const cmd = Array.isArray(args.command) ? (args.command as unknown[]).map(String) : []
        if (cmd.length === 0) return 'Error: namespace, pod and command are required'
        const binary = cmd[0].replace(/^.*\//, '') // strip any path prefix e.g. /bin/cat → cat
        if (!EXEC_ALLOWED.has(binary)) return `Error: command '${binary}' is not permitted. Allowed: ${[...EXEC_ALLOWED].join(', ')}`
        const base = ['exec', '-n', k8sNamespace('namespace', args.namespace)]
        if (args.container) base.push('-c', k8sLabel('container', args.container))
        base.push(k8sName('pod', args.pod))
        return kubectl([...base, '--', ...cmd], 30_000)
      })
    },
  },

  {
    name: 'kubectl_wait_nodes_ready',
    description: 'Wait for cluster nodes to be in Ready condition',
    inputSchema: {
      type: 'object',
      properties: {
        timeout:   { type: 'string', description: 'Timeout (default 300s)' },
        nodeNames: { type: 'array', items: { type: 'string' }, description: 'Specific node IPs to wait for (looks up node names). If omitted, waits for all nodes.' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const ktimeout = duration('timeout', args.timeout ?? '300s')
        const execMs   = (durationSeconds(ktimeout) + 10) * 1_000
        const nodeIps  = Array.isArray(args.nodeNames) ? (args.nodeNames as string[]) : []

        if (nodeIps.length === 0) {
          return kubectl(['wait', '--for=condition=Ready', 'nodes', '--all', `--timeout=${ktimeout}`], execMs)
        }

        // Resolve IPs to node names via kubectl get nodes (names come from the API, not the agent)
        const nodesJson = await kubectlJson(['get', 'nodes', '-o', 'json'], 10_000)
        const list = JSON.parse(nodesJson) as { items?: { metadata?: { name?: string }; status?: { addresses?: { type: string; address: string }[] } }[] }
        const nodeNames: string[] = []
        for (const ip of nodeIps) {
          const node = (list.items ?? []).find(n =>
            (n.status?.addresses ?? []).some(a => a.address === ip),
          )
          if (node?.metadata?.name) nodeNames.push(node.metadata.name)
        }
        if (nodeNames.length === 0) return 'No matching nodes found'
        return kubectl(['wait', '--for=condition=Ready', `--timeout=${ktimeout}`, '--', ...nodeNames.map(n => `node/${n}`)], execMs)
      })
    },
  },

  {
    name: 'helm_repo_add',
    description: 'Add a Helm chart repository (helm repo add)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        url:  { type: 'string', description: 'Repository URL' },
      },
      required: ['name', 'url'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const name = helmName('name', args.name)
        const url = httpUrl('url', args.url, ['http:', 'https:', 'oci:'])
        try {
          return await helm(['repo', 'add', '--', name, url])
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('already exists')) return `Repository "${name}" already exists`
          throw new Error(`helm repo add failed: ${msg}`, { cause: e })
        }
      })
    },
  },

  {
    name: 'helm_list',
    description: 'List Helm releases (helm list)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list releases in' },
        filter:    { type: 'string', description: 'Optional regex filter on release name' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const cmdArgs = ['list', '--short']
        if (args.namespace) cmdArgs.push('-n', k8sNamespace('namespace', args.namespace))
        if (args.filter) cmdArgs.push(`--filter=${noFlag('filter', args.filter, 256)}`)
        return helm(cmdArgs)
      })
    },
  },

  {
    name: 'helm_uninstall',
    description: 'Uninstall a Helm release (helm uninstall)',
    inputSchema: {
      type: 'object',
      properties: {
        release:     { type: 'string', description: 'Release name' },
        namespace:   { type: 'string', description: 'Namespace the release is installed in' },
        timeout:     { type: 'string', description: 'Timeout (default 60s)' },
      },
      required: ['release', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => helm([
        'uninstall',
        '--namespace', k8sNamespace('namespace', args.namespace),
        '--timeout', duration('timeout', args.timeout ?? '60s'),
        '--', helmName('release', args.release),
      ]))
    },
  },

  {
    name: 'storage_stats',
    description: 'Get storage capacity stats for the cluster. Auto-detects Longhorn or Rook-Ceph and returns total/used/free bytes per node.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>) {
      // Helper: check if a namespace exists.
      // kubectl get namespace <ns> --ignore-not-found exits 0 and prints NOTHING
      // when the namespace is absent, so checking exit code alone always returns true.
      // Must check that stdout is non-empty to confirm the resource was found.
      async function nsExists(ns: string): Promise<boolean> {
        try {
          const out = await kubectl(['get', 'namespace', ns, '--ignore-not-found', '--no-headers'])
          return out.trim().length > 0
        } catch { return false }
      }

      const [hasLonghorn, hasCeph] = await Promise.all([
        nsExists('longhorn-system'),
        nsExists('rook-ceph'),
      ])

      if (hasLonghorn) {
        const json = await kubectlJson(['get', 'nodes.longhorn.io', '-n', 'longhorn-system', '-o', 'json'])
        const list = JSON.parse(json) as { items?: unknown[] }
        const items = list.items ?? []
        const nodes: Array<{ name: string; totalGiB: number; usedGiB: number; freeGiB: number }> = []
        let clusterTotal = 0, clusterFree = 0
        for (const node of items as any[]) {
          const diskStatus = node.status?.diskStatus ?? {}
          let total = 0, free = 0
          for (const disk of Object.values(diskStatus) as any[]) {
            total += disk.storageMaximum   ?? 0
            free  += disk.storageAvailable ?? 0
          }
          if (total > 0) {
            const toGiB = (b: number) => Math.round(b / 1073741824 * 10) / 10
            nodes.push({ name: node.metadata?.name ?? 'unknown', totalGiB: toGiB(total), usedGiB: toGiB(total - free), freeGiB: toGiB(free) })
            clusterTotal += total
            clusterFree  += free
          }
        }
        const toGiB = (b: number) => Math.round(b / 1073741824 * 10) / 10
        const usedPct = clusterTotal > 0 ? Math.round((clusterTotal - clusterFree) / clusterTotal * 100) : 0
        const lines = [
          `Storage provider: Longhorn`,
          `Cluster: ${toGiB(clusterTotal)} GiB total, ${toGiB(clusterTotal - clusterFree)} GiB used (${usedPct}%), ${toGiB(clusterFree)} GiB free`,
          '',
          'Per-node breakdown:',
          ...nodes.map(n => `  ${n.name}: ${n.totalGiB} GiB total, ${n.usedGiB} GiB used, ${n.freeGiB} GiB free`),
        ]
        return lines.join('\n')
      }

      if (hasCeph) {
        const json = await kubectlJson(['get', 'cephcluster', 'rook-ceph', '-n', 'rook-ceph', '-o', 'json'])
        const cluster = JSON.parse(json) as any
        const cap = cluster.status?.ceph?.capacity ?? {}
        const toGiB = (b: number) => Math.round(b / 1073741824 * 10) / 10
        const total = cap.bytesTotal     ?? 0
        const used  = cap.bytesUsed      ?? 0
        const free  = cap.bytesAvailable ?? 0
        const usedPct = total > 0 ? Math.round(used / total * 100) : 0
        return `Storage provider: Rook-Ceph\nCluster: ${toGiB(total)} GiB total, ${toGiB(used)} GiB used (${usedPct}%), ${toGiB(free)} GiB free`
      }

      return 'No storage provider detected (checked: longhorn-system, rook-ceph namespaces)'
    },
  },

  {
    name: 'helm_upgrade_install',
    description: 'Install or upgrade a Helm chart (helm upgrade --install)',
    inputSchema: {
      type: 'object',
      properties: {
        release:          { type: 'string', description: 'Release name' },
        chart:            { type: 'string', description: 'Chart name or path (e.g. "repo/chart" or full URL)' },
        repo:             { type: 'string', description: 'Helm repo name or URL. If it starts with http, uses --repo mode. Otherwise uses local cache.' },
        namespace:        { type: 'string', description: 'Namespace to install into' },
        createNamespace:  { type: 'boolean', description: 'Create namespace if it does not exist' },
        values:           { type: 'object', description: 'Simple values to set (key: value pairs). For complex/nested values use valuesFile.' },
        valuesFile:       { type: 'string', description: 'Full YAML values file as a string. Used for arrays and nested structures.' },
        wait:             { type: 'boolean', description: 'Wait for release to be ready (default true)' },
        timeout:          { type: 'string', description: 'Timeout (default 120s)' },
      },
      required: ['release', 'chart', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(async () => {
        const release = helmName('release', args.release)
        const chart = noFlag('chart', args.chart, 512)
        const repo = args.repo === undefined || args.repo === '' ? '' : noFlag('repo', args.repo, 2048)
        const cmdArgs: string[] = ['upgrade', '--install']
        // If repo is a URL, use --repo mode (remote repo without pre-registering)
        // --repo takes a URL string (not NAME URL pair)
        if (repo.startsWith('http')) cmdArgs.push('--repo', httpUrl('repo', repo))
        cmdArgs.push(
          '--namespace', k8sNamespace('namespace', args.namespace),
          '--timeout', duration('timeout', args.timeout ?? '120s'),
        )
        if (args.createNamespace) cmdArgs.push('--create-namespace')
        if (args.wait !== false)  cmdArgs.push('--wait')

        // Handle valuesFile (YAML string for complex/nested values including arrays)
        if (args.valuesFile) {
          const tmpFile = `/tmp/helm-values-${randomUUID()}.yaml`
          writeFileSync(tmpFile, String(args.valuesFile), { mode: 0o600 })
          cmdArgs.push('--values', tmpFile, '--', release, chart)
          try {
            return await helm(cmdArgs)
          } finally {
            try { unlinkSync(tmpFile) } catch { /* ignore */ }
          }
        }
        // Simple key-value --set flags
        const values = args.values as Record<string, unknown> | undefined
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*$/.test(k)) {
              return `Error: Invalid argument 'values': key '${k}' is not a valid Helm value path`
            }
            cmdArgs.push('--set', `${k}=${v}`)
          }
        }
        cmdArgs.push('--', release, chart)
        return helm(cmdArgs)
      })
    },
  },
] as const).map(t => ({ ...t, category: 'cluster-ops' as const }))
