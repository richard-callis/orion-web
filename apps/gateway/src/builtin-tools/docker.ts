import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

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
    description: 'Execute a command inside a running container',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        command:   { type: 'string', description: 'Command to run (passed to sh -c)' },
      },
      required: ['container', 'command'],
    },
    async execute(args: Record<string, unknown>) {
      return docker(['exec', String(args.container), 'sh', '-c', String(args.command)])
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
        volumes: { type: 'array', items: { type: 'string' }, description: 'Volume mounts e.g. ["/var/run/docker.sock:/var/run/docker.sock:ro"]' },
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
