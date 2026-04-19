import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'

const exec = promisify(execFile)

async function kubectl(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec('kubectl', args, { timeout: timeoutMs })
  return stdout || stderr
}

async function helm(args: string[]): Promise<string> {
  const { stdout, stderr } = await exec('helm', args, { timeout: 300_000 })
  return stdout || stderr
}

export const kubernetesTools = [
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
      const cmdArgs = ['get', 'pods', '-o', 'wide']
      if (args.namespace) cmdArgs.push('-n', String(args.namespace))
      else cmdArgs.push('-A')
      if (args.selector) cmdArgs.push('-l', String(args.selector))
      return kubectl(cmdArgs)
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
      const cmdArgs = ['logs', String(args.pod), '-n', String(args.namespace), `--tail=${args.tail ?? 100}`]
      if (args.container) cmdArgs.push('-c', String(args.container))
      if (args.previous) cmdArgs.push('--previous')
      return kubectl(cmdArgs)
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
      const cmdArgs = ['describe', String(args.resource), String(args.name)]
      if (args.namespace) cmdArgs.push('-n', String(args.namespace))
      return kubectl(cmdArgs)
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
      const cmdArgs = ['get', String(args.resource)]
      if (args.name) cmdArgs.push(String(args.name))
      if (args.namespace) cmdArgs.push('-n', String(args.namespace))
      else if (!args.name) cmdArgs.push('-A')
      cmdArgs.push('-o', String(args.output ?? 'wide'))
      return kubectl(cmdArgs)
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
      return kubectl(['rollout', 'restart', `${args.kind}/${args.name}`, '-n', String(args.namespace)])
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
      const cmdArgs = ['top', 'pods']
      if (args.namespace) cmdArgs.push('-n', String(args.namespace))
      else cmdArgs.push('-A')
      return kubectl(cmdArgs)
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
      const cmdArgs = ['apply', '-f', String(args.url)]
      if (args.namespace) cmdArgs.push('-n', String(args.namespace))
      return kubectl(cmdArgs, 120_000) // 2 min — large manifests take time to download + apply
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
      const manifest = String(args.manifest)
      const tmpFile = `/tmp/orion-manifest-${Date.now()}.yaml`
      writeFileSync(tmpFile, manifest, 'utf8')
      try {
        const { stdout, stderr } = await exec('kubectl', ['apply', '-f', tmpFile], { timeout: 60_000 })
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
    },
  },
  {
    name: 'kubectl_rollout_status',
    description: 'Wait for a rollout to complete',
    inputSchema: {
      type: 'object',
      properties: {
        kind:      { type: 'string', description: 'Resource kind (deployment, statefulset, daemonset)' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace' },
        timeout:   { type: 'string', description: 'Timeout (default 120s)' },
      },
      required: ['kind', 'name', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      // Parse the kubectl --timeout value and add 5s buffer for the Node exec timeout
      const ktimeout = String(args.timeout ?? '120s')
      const seconds  = ktimeout.endsWith('s') ? parseInt(ktimeout) : parseInt(ktimeout) * 60
      const execMs   = (seconds + 5) * 1_000
      return kubectl([
        'rollout', 'status', `${args.kind}/${args.name}`,
        '-n', String(args.namespace),
        `--timeout=${ktimeout}`,
      ], execMs)
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
      const ktimeout = String(args.timeout ?? '300s')
      const seconds  = ktimeout.endsWith('s') ? parseInt(ktimeout) : parseInt(ktimeout) * 60
      const execMs   = (seconds + 10) * 1_000
      const nodeIps  = Array.isArray(args.nodeNames) ? (args.nodeNames as string[]) : []

      if (nodeIps.length === 0) {
        return kubectl(['wait', '--for=condition=Ready', 'nodes', '--all', `--timeout=${ktimeout}`], execMs)
      }

      // Resolve IPs to node names via kubectl get nodes
      const nodesJson = await kubectl(['get', 'nodes', '-o', 'json'], 10_000)
      const list = JSON.parse(nodesJson) as { items?: { metadata?: { name?: string }; status?: { addresses?: { type: string; address: string }[] } }[] }
      const nodeNames: string[] = []
      for (const ip of nodeIps) {
        const node = (list.items ?? []).find(n =>
          (n.status?.addresses ?? []).some(a => a.address === ip),
        )
        if (node?.metadata?.name) nodeNames.push(node.metadata.name)
      }
      if (nodeNames.length === 0) return 'No matching nodes found'
      return kubectl(['wait', '--for=condition=Ready', ...nodeNames.map(n => `node/${n}`), `--timeout=${ktimeout}`], execMs)
    },
  },

  {
    name: 'helm_upgrade_install',
    description: 'Install or upgrade a Helm chart (helm upgrade --install)',
    inputSchema: {
      type: 'object',
      properties: {
        release:          { type: 'string', description: 'Release name' },
        chart:            { type: 'string', description: 'Chart name or path' },
        repo:             { type: 'string', description: 'Helm repo URL (optional)' },
        namespace:        { type: 'string', description: 'Namespace to install into' },
        createNamespace:  { type: 'boolean', description: 'Create namespace if it does not exist' },
        values:           { type: 'object', description: 'Values to set (key: value pairs)' },
        wait:             { type: 'boolean', description: 'Wait for release to be ready (default true)' },
        timeout:          { type: 'string', description: 'Timeout (default 120s)' },
      },
      required: ['release', 'chart', 'namespace'],
    },
    async execute(args: Record<string, unknown>) {
      const cmdArgs = [
        'upgrade', '--install', String(args.release), String(args.chart),
        '--namespace', String(args.namespace),
        '--timeout', String(args.timeout ?? '120s'),
      ]
      if (args.repo)            cmdArgs.push('--repo', String(args.repo))
      if (args.createNamespace) cmdArgs.push('--create-namespace')
      if (args.wait !== false)  cmdArgs.push('--wait')
      const values = args.values as Record<string, unknown> | undefined
      if (values) {
        for (const [k, v] of Object.entries(values)) {
          cmdArgs.push('--set', `${k}=${v}`)
        }
      }
      return helm(cmdArgs)
    },
  },
]
