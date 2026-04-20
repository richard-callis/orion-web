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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_rollout_status' },
    builtIn: true,
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_apply_url' },
    builtIn: true,
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_apply_manifest' },
    builtIn: true,
  },
  {
    name: 'kubectl_wait_nodes_ready',
    description: 'Wait for all cluster nodes to be in Ready condition',
    inputSchema: {
      type: 'object',
      properties: {
        timeout:   { type: 'string', description: 'Timeout (default 300s)' },
        nodeNames: { type: 'array', items: { type: 'string' }, description: 'Specific node IPs to wait for. If omitted, waits for all nodes.' },
      },
    },
    execType: 'builtin',
    execConfig: { fn: 'kubectl_wait_nodes_ready' },
    builtIn: true,
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
    execType: 'builtin',
    execConfig: { fn: 'kubectl_patch' },
    builtIn: true,
  },
  {
    name: 'helm_upgrade_install',
    description: 'Install or upgrade a Helm chart (helm upgrade --install)',
    inputSchema: {
      type: 'object',
      properties: {
        release:         { type: 'string', description: 'Release name' },
        chart:           { type: 'string', description: 'Chart name or path' },
        repo:            { type: 'string', description: 'Helm repo URL (optional)' },
        namespace:       { type: 'string', description: 'Namespace to install into' },
        createNamespace: { type: 'boolean', description: 'Create namespace if it does not exist' },
        values:          { type: 'object', description: 'Values to set (key: value pairs)' },
        wait:            { type: 'boolean', description: 'Wait for release to be ready (default true)' },
        timeout:         { type: 'string', description: 'Timeout (default 120s)' },
      },
      required: ['release', 'chart', 'namespace'],
    },
    execType: 'builtin',
    execConfig: { fn: 'helm_upgrade_install' },
    builtIn: true,
  },
]

export const TALOS_DEFAULT_TOOLS: DefaultTool[] = [
  {
    name: 'talos_get_version',
    description: 'Get Talos version info for a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    execType: 'builtin',
    execConfig: { fn: 'talos_get_version' },
    builtIn: true,
  },
  {
    name: 'talos_get_extensions',
    description: 'List installed Talos system extensions on a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    execType: 'builtin',
    execConfig: { fn: 'talos_get_extensions' },
    builtIn: true,
  },
  {
    name: 'talos_patch_machineconfig',
    description: 'Apply a JSON patch to the Talos machine config on a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
        patch:       { type: 'string', description: 'JSON patch array (RFC 6902)' },
      },
      required: ['nodeIp', 'talosConfig', 'patch'],
    },
    execType: 'builtin',
    execConfig: { fn: 'talos_patch_machineconfig' },
    builtIn: true,
  },
  {
    name: 'talos_upgrade',
    description: 'Upgrade a Talos node to a new installer image (applies pending config changes, reboots)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:         { type: 'string', description: 'Node IP address' },
        talosConfig:    { type: 'string', description: 'Base64-encoded talosconfig content' },
        installerImage: { type: 'string', description: 'Talos installer image, e.g. factory.talos.dev/installer/<id>:v1.9.5' },
        preserve:       { type: 'boolean', description: 'Preserve data across upgrade (default true)' },
      },
      required: ['nodeIp', 'talosConfig', 'installerImage'],
    },
    execType: 'builtin',
    execConfig: { fn: 'talos_upgrade' },
    builtIn: true,
  },
  {
    name: 'talos_reboot',
    description: 'Reboot a Talos node (applies pending config changes)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    execType: 'builtin',
    execConfig: { fn: 'talos_reboot' },
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
  {
    name: 'docker_run',
    description: 'Run a Docker container (idempotent — removes existing container with same name first)',
    inputSchema: {
      type: 'object',
      properties: {
        image:   { type: 'string', description: 'Docker image to run' },
        name:    { type: 'string', description: 'Container name' },
        restart: { type: 'string', description: 'Restart policy (e.g. unless-stopped, always, no)' },
        ports:   { type: 'array', items: { type: 'string' }, description: 'Port mappings e.g. ["80:80", "443:443"]' },
        volumes: { type: 'array', items: { type: 'string' }, description: 'Volume mounts e.g. ["/data:/data"]' },
        env:     { type: 'object', description: 'Environment variables as key/value pairs' },
        args:    { type: 'array', items: { type: 'string' }, description: 'Extra arguments passed to the container (CMD)' },
        detach:  { type: 'boolean', description: 'Run in background (default true)' },
      },
      required: ['image'],
    },
    execType: 'builtin',
    execConfig: { fn: 'docker_run' },
    builtIn: true,
  },
]

export const LOCALHOST_DEFAULT_TOOLS: DefaultTool[] = [
  // Docker tools — localhost gateway mounts the Docker socket
  ...DOCKER_DEFAULT_TOOLS,

  // Host shell access
  {
    name: 'shell_exec',
    description: 'Run a shell command on the ORION management host',
    inputSchema: {
      type: 'object',
      properties: {
        command:      { type: 'string', description: 'The shell command to run' },
        timeout_secs: { type: 'number', description: 'Max seconds to wait (default 30)' },
      },
      required: ['command'],
    },
    execType: 'builtin',
    execConfig: { fn: 'shell_exec' },
    builtIn: true,
  },

  // File read
  {
    name: 'file_read',
    description: 'Read a file from the ORION management host filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path:      { type: 'string', description: 'Absolute path to the file' },
        max_bytes: { type: 'number', description: 'Maximum bytes to read (default 65536)' },
      },
      required: ['path'],
    },
    execType: 'builtin',
    execConfig: { fn: 'file_read' },
    builtIn: true,
  },

  // System info
  {
    name: 'system_info',
    description: 'Show CPU, memory, disk usage, and uptime for the ORION management host',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execType: 'builtin',
    execConfig: { fn: 'system_info' },
    builtIn: true,
  },
]

export function getDefaultTools(type: string): DefaultTool[] {
  if (type === 'cluster')   return [...KUBERNETES_DEFAULT_TOOLS, ...TALOS_DEFAULT_TOOLS]
  if (type === 'docker')    return DOCKER_DEFAULT_TOOLS
  // localhost gateway co-exists with ORION on the management host — it can reach the
  // local cluster directly, so seed kubernetes + talos tools alongside host tools.
  if (type === 'localhost') return [...LOCALHOST_DEFAULT_TOOLS, ...KUBERNETES_DEFAULT_TOOLS, ...TALOS_DEFAULT_TOOLS]
  return []
}
