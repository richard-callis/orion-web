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
    async execute(args: Record<string, string>) {
      return docker(['inspect', args.container])
    },
  },
]
