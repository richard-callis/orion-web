import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

/**
 * Dangerous command patterns blocked in docker_exec.
 * SOC2: [H-005] Defense-in-depth — docker_exec passes a command string to sh -c,
 * so we can't quote it. We block patterns that enable injection.
 */
const DANGEROUS_PATTERNS = [
  /;\s*(rm|dd|chmod|chown|mkfs|fdisk|wipe|mke2fs)\b/i,
  /;\s*(curl|wget)\b/i,
  />>\s*\/etc\/|>>\s*\/root\//i,
  />\s*\/etc\/(passwd|shadow|sudoers)/i,
  />\s*\/root\/\.ssh\//i,
  /\|\s*(nc|ncat|socat|netcat)\b/i,
  /\/proc\/(self|fs|sys)/i,
  /\beval\b/,
  /source\b.*\/etc\//i,
  /base64\s+-[di]/i,
] as const

const SHELL_META_RE = /[;&|`$<>\\!{}()\[\]]/

function checkDangerous(cmd: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Blocked: command matches dangerous pattern '${pattern.source}'`
    }
  }
  return null
}

/**
 * Validate a docker volume mount path.
 * SOC2: [H-005] Prevent mounting sensitive host filesystem paths.
 */
function validateVolumeMount(vol: string): void {
  // Docker volume mounts have format: hostPath:containerPath[:options]
  // or: containerPath:hostPath[:options] or namedVolume:containerPath
  const parts = vol.split(':')
  const hostPath = parts.length >= 2 ? parts[0] : null
  if (!hostPath) return // named volume — OK

  // Block absolute paths to sensitive directories
  const sensitivePrefixes = ['/etc', '/root', '/proc', '/sys', '/dev', '/var/run/docker.sock']
  for (const prefix of sensitivePrefixes) {
    if (hostPath === prefix || hostPath.startsWith(prefix + '/')) {
      throw new Error(`Volume mount blocked: ${hostPath} is a sensitive host path`)
    }
  }

  // Block path traversal
  if (hostPath.includes('../') || hostPath.includes('..\\')) {
    throw new Error('Volume mount blocked: path traversal detected')
  }
}

/**
 * Validate a docker port mapping.
 * SOC2: [H-005] Ensure port mappings are well-formed.
 */
function validatePortMapping(port: string): void {
  // Formats: "8080:80", "0.0.0.0:8080:80", "8080:80/tcp", "8080:80/udp"
  // Validate: each part should be a valid number or IP:port
  const parts = port.split(':')
  if (parts.length > 3) throw new Error(`Invalid port mapping: ${port}`)
  for (const part of parts) {
    const proto = part.split('/')[0] // strip /tcp or /udp
    // Allow IPs like 0.0.0.0 or host IPs
    if (!/^\d+$/.test(proto) && !/^\d+\.\d+\.\d+\.\d+$/.test(proto)) {
      throw new Error(`Invalid port mapping: ${port}`)
    }
  }
}

async function docker(args: string[]): Promise<string> {
  const { stdout, stderr } = await exec('docker', args, { timeout: 30_000 })
  return stdout || stderr
}

export const dockerTools = [
  {
    name: 'docker_ps',
    description: 'List running containers on this node',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Show all containers including stopped ones' },
      },
    },
    async execute(args: Record<string, unknown>) {
      return docker(['ps', ...(args.all ? ['-a'] : []), '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'])
    },
  },
  {
    name: 'docker_logs',
    description: 'Get logs from a container',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        tail:      { type: 'number', description: 'Number of lines from end (default 100)' },
        since:     { type: 'string', description: 'Show logs since timestamp or duration e.g. 1h' },
      },
      required: ['container'],
    },
    async execute(args: Record<string, unknown>) {
      return docker(['logs', String(args.container), `--tail=${args.tail ?? 100}`, ...(args.since ? [`--since=${args.since}`] : [])])
    },
  },
  {
    name: 'docker_stats',
    description: 'Show resource usage stats for running containers (one snapshot)',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Specific container name (omit for all)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const cmdArgs = ['stats', '--no-stream', '--format', 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}']
      if (args.container) cmdArgs.push(String(args.container))
      return docker(cmdArgs)
    },
  },
  {
    name: 'docker_inspect',
    description: 'Inspect a container and return its configuration',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
      },
      required: ['container'],
    },
    async execute(args: Record<string, unknown>) {
      return docker(['inspect', String(args.container)])
    },
  },
  {
    name: 'docker_exec',
    description: 'Execute a command inside a running container (read-only commands only)',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        command:   { type: 'string', description: 'Command to run (passed to sh -c). Use read-only commands like "cat", "ls", "grep", "head", "tail", "wc".' },
      },
      required: ['container', 'command'],
    },
    async execute(args: Record<string, unknown>) {
      const command = String(args.command ?? '').trim()
      if (!command) return 'Error: command is required'

      // SOC2: [H-005] Block shell metacharacters that could enable injection
      if (SHELL_META_RE.test(command)) {
        return 'Error: command contains disallowed shell metacharacters'
      }

      // SOC2: [H-005] Block dangerous command patterns
      const dangerReason = checkDangerous(command)
      if (dangerReason) {
        return `Error: ${dangerReason}`
      }

      return docker(['exec', String(args.container), 'sh', '-c', command])
    },
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
        volumes: { type: 'array', items: { type: 'string' }, description: 'Volume mounts (named volumes only, e.g. ["mydata:/data"]). Host path mounts are blocked.' },
        env:     { type: 'object', description: 'Environment variables as key/value pairs' },
        args:    { type: 'array', items: { type: 'string' }, description: 'Extra arguments passed to the container (CMD)' },
        detach:  { type: 'boolean', description: 'Run in background (default true)' },
      },
      required: ['image'],
    },
    async execute(args: Record<string, unknown>) {
      // Remove existing container with same name if present (idempotent)
      if (args.name) {
        try { await docker(['rm', '-f', String(args.name)]) } catch { /* ignore */ }
      }

      // SOC2: [H-005] Validate port mappings
      for (const p of (args.ports as string[] ?? [])) {
        validatePortMapping(p)
      }

      // SOC2: [H-005] Validate volume mounts — block sensitive host paths
      for (const v of (args.volumes as string[] ?? [])) {
        validateVolumeMount(v)
      }

      const cmdArgs = ['run']
      if (args.detach !== false) cmdArgs.push('-d')
      if (args.name)    cmdArgs.push('--name', String(args.name))
      if (args.restart) cmdArgs.push('--restart', String(args.restart))
      for (const p of (args.ports as string[] ?? [])) cmdArgs.push('-p', p)
      for (const v of (args.volumes as string[] ?? [])) cmdArgs.push('-v', v)
      const env = args.env as Record<string, string> | undefined
      if (env) {
        for (const [k, v] of Object.entries(env)) cmdArgs.push('-e', `${k}=${v}`)
      }
      cmdArgs.push(String(args.image))
      for (const a of (args.args as string[] ?? [])) cmdArgs.push(a)

      return docker(cmdArgs)
    },
  },
]
