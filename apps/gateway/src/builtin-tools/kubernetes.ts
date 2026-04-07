import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

async function kubectl(args: string[]): Promise<string> {
  const { stdout, stderr } = await exec('kubectl', args, { timeout: 30_000 })
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
    async execute(args: Record<string, string>) {
      const cmdArgs = ['get', 'pods', '-o', 'wide']
      if (args.namespace) cmdArgs.push('-n', args.namespace)
      else cmdArgs.push('-A')
      if (args.selector) cmdArgs.push('-l', args.selector)
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
    async execute(args: Record<string, string>) {
      const cmdArgs = ['describe', args.resource, args.name]
      if (args.namespace) cmdArgs.push('-n', args.namespace)
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
    async execute(args: Record<string, string>) {
      const cmdArgs = ['get', args.resource]
      if (args.name) cmdArgs.push(args.name)
      if (args.namespace) cmdArgs.push('-n', args.namespace)
      else if (!args.name) cmdArgs.push('-A')
      cmdArgs.push('-o', args.output ?? 'wide')
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
    async execute(args: Record<string, string>) {
      return kubectl(['rollout', 'restart', `${args.kind}/${args.name}`, '-n', args.namespace])
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
    async execute(args: Record<string, string>) {
      const cmdArgs = ['top', 'pods']
      if (args.namespace) cmdArgs.push('-n', args.namespace)
      else cmdArgs.push('-A')
      return kubectl(cmdArgs)
    },
  },
]
