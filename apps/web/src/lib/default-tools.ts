/**
 * Default tools seeded into an environment on creation.
 * builtIn: true  → executed by the gateway's built-in registry (matches gateway/src/builtin-tools/)
 * builtIn: false → executed via shell/http by the tool-runner
 */

interface DefaultTool {
  name: string
  description: string
  inputSchema: object
  execType: string
  execConfig: object | null
  builtIn: boolean
}

export const KUBERNETES_DEFAULT_TOOLS: DefaultTool[] = [
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_get_pods' },
    builtIn: true,
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_get_nodes' },
    builtIn: true,
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
        previous:  { type: 'boolean', description: 'Get logs from previous crashed container' },
      },
      required: ['pod', 'namespace'],
    },
    execType: 'builtin',
    execConfig: { fn: 'kubectl_logs' },
    builtIn: true,
  },
  {
    name: 'kubectl_describe',
    description: 'Describe a Kubernetes resource in detail',
    inputSchema: {
      type: 'object',
      properties: {
        resource:  { type: 'string', description: 'Resource type, e.g. pod, deployment, service, node' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace (for namespaced resources)' },
      },
      required: ['resource', 'name'],
    },
    execType: 'builtin',
    execConfig: { fn: 'kubectl_describe' },
    builtIn: true,
  },
  {
    name: 'kubectl_get',
    description: 'Get any Kubernetes resource in JSON, YAML, or wide format',
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_get' },
    builtIn: true,
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_top_pods' },
    builtIn: true,
  },
  {
    name: 'kubectl_rollout_restart',
    description: 'Restart a deployment, statefulset, or daemonset with zero downtime',
    inputSchema: {
      type: 'object',
      properties: {
        kind:      { type: 'string', enum: ['deployment', 'statefulset', 'daemonset'], description: 'Resource kind' },
        name:      { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace' },
      },
      required: ['kind', 'name', 'namespace'],
    },
    execType: 'builtin',
    execConfig: { fn: 'kubectl_rollout_restart' },
    builtIn: true,
  },
]

export const DOCKER_DEFAULT_TOOLS: DefaultTool[] = [
  {
    name: 'docker_ps',
    description: 'List running containers on this node',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Show all containers including stopped ones' },
      },
    },
    execType: 'builtin',
    execConfig: { fn: 'docker_ps' },
    builtIn: true,
  },
  {
    name: 'docker_logs',
    description: 'Get logs from a container',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        tail:      { type: 'number', description: 'Number of lines from end (default 100)' },
        since:     { type: 'string', description: 'Show logs since timestamp or duration, e.g. 1h' },
      },
      required: ['container'],
    },
    execType: 'builtin',
    execConfig: { fn: 'docker_logs' },
    builtIn: true,
  },
  {
    name: 'docker_stats',
    description: 'Show CPU and memory usage for running containers (one snapshot)',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Specific container name (omit for all)' },
      },
    },
    execType: 'builtin',
    execConfig: { fn: 'docker_stats' },
    builtIn: true,
  },
  {
    name: 'docker_inspect',
    description: 'Inspect a container and return its full configuration',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
      },
      required: ['container'],
    },
    execType: 'builtin',
    execConfig: { fn: 'docker_inspect' },
    builtIn: true,
  },
]

export function getDefaultTools(type: string): DefaultTool[] {
  if (type === 'cluster') return KUBERNETES_DEFAULT_TOOLS
  if (type === 'docker')  return DOCKER_DEFAULT_TOOLS
  return []
}
