import { runOut } from '../lib/run.js'
import { withValidation, noFlag, dockerName, imageRef, positiveInt, duration } from '../lib/validate-args.js'

async function docker(args: string[]): Promise<string> {
  return runOut('docker', args, { timeoutMs: 30_000 })
}

const RESTART_POLICY = /^(no|always|unless-stopped|on-failure(:\d{1,3})?)$/
const PORT_SPEC = /^[0-9a-fA-F.:[\]]+(\/(tcp|udp|sctp))?$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

// Agent-supplied names/values are validated so they cannot be read as docker CLI
// flags (e.g. a container name of "--privileged"), and positionals follow `--`.

export const dockerTools = ([
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
      return withValidation(async () => {
        const tail = args.tail === undefined ? 100 : positiveInt('tail', args.tail)
        const cmd = ['logs', `--tail=${tail}`]
        if (args.since) {
          // Accept a Go duration (1h, 30m) or an RFC 3339 / unix timestamp.
          const since = /^\d{4}-\d{2}-\d{2}/.test(String(args.since))
            ? noFlag('since', args.since, 64)
            : duration('since', args.since)
          cmd.push(`--since=${since}`)
        }
        cmd.push('--', dockerName('container', args.container))
        return docker(cmd)
      })
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
      return withValidation(async () => {
        const cmdArgs = ['stats', '--no-stream', '--format', 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}']
        if (args.container) cmdArgs.push('--', dockerName('container', args.container))
        return docker(cmdArgs)
      })
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
      return withValidation(async () => docker(['inspect', '--', dockerName('container', args.container)]))
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
      return withValidation(async () =>
        docker(['exec', dockerName('container', args.container), 'sh', '-c', String(args.command ?? '')]),
      )
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
      return withValidation(async () => {
        const name = args.name ? dockerName('name', args.name) : undefined
        const image = imageRef('image', args.image)

        const cmdArgs = ['run']
        if (args.detach !== false) cmdArgs.push('-d')
        if (name) cmdArgs.push(`--name=${name}`)
        if (args.restart) {
          const restart = String(args.restart)
          if (!RESTART_POLICY.test(restart)) return `Error: Invalid argument 'restart': must be no, always, unless-stopped or on-failure[:N]`
          cmdArgs.push(`--restart=${restart}`)
        }
        for (const p of (args.ports as unknown[] ?? [])) {
          const port = noFlag('ports', p, 64)
          if (!PORT_SPEC.test(port)) return `Error: Invalid argument 'ports': '${port}' is not a valid port mapping`
          cmdArgs.push(`--publish=${port}`)
        }
        for (const v of (args.volumes as unknown[] ?? [])) cmdArgs.push(`--volume=${noFlag('volumes', v, 1024)}`)
        const env = args.env as Record<string, unknown> | undefined
        if (env) {
          for (const [k, v] of Object.entries(env)) {
            if (!ENV_KEY.test(k)) return `Error: Invalid argument 'env': '${k}' is not a valid variable name`
            cmdArgs.push('--env', `${k}=${String(v)}`)
          }
        }
        // Image is the first positional; everything after it is the container CMD
        // (docker stops parsing its own flags at the image).
        cmdArgs.push('--', image)
        for (const a of (args.args as unknown[] ?? [])) cmdArgs.push(String(a))

        // Remove existing container with same name if present (idempotent)
        if (name) {
          try { await docker(['rm', '-f', '--', name]) } catch { /* ignore */ }
        }
        return docker(cmdArgs)
      })
    },
  },
] as const).map(t => ({ ...t, category: 'docker' as const }))
