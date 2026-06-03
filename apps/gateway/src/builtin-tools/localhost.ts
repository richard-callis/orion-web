import { randomUUID } from 'crypto'
import { executorClient } from '../executor-client.js'

/**
 * File read allowlist — paths permitted via file_read.
 * Gateway enforces this as a defense-in-depth control;
 * executor also validates against its own allowlist.
 */
const FILE_READ_ALLOWLIST = [
  '/var/log',
  '/etc/hosts',
  '/proc/cpuinfo',
  '/proc/meminfo',
]

function isFileReadAllowed(path: string): boolean {
  return FILE_READ_ALLOWLIST.some(allowed => path.startsWith(allowed))
}

export const localhostTools = ([
  {
    name: 'shell_exec',
    description: 'Run a shell command on the ORION management host',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute, e.g. "df -h" or "systemctl status docker"',
        },
        timeout_secs: {
          type: 'number',
          description: 'Max seconds to wait (default 30)',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, unknown>, ctx?: { agentId?: string; userId?: string; actorType?: 'agent' | 'human' }) {
      const command = String(args.command ?? '').trim()
      if (!command) return 'Error: command is required'

      console.log(`[localhost] shell_exec: ${command}`)

      const executionId = randomUUID()
      const result = await executorClient.execute({
        tool: 'shell_exec',
        args: { command },
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.agentId ? 'agent' : 'human',
        executionId,
      })

      if (result.error) {
        return `Error: ${result.error}`
      }

      return result.output?.trim() || '(no output)'
    },
  },

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
    async execute(args: Record<string, unknown>, ctx?: { agentId?: string; userId?: string; actorType?: 'agent' | 'human' }) {
      const filePath = String(args.path ?? '').trim()
      if (!filePath) return 'Error: path is required'

      // Validate path against allowlist
      if (!isFileReadAllowed(filePath)) {
        return `Error: path '${filePath}' is not in the allowlist`
      }

      console.log(`[localhost] file_read: ${filePath}`)

      const executionId = randomUUID()
      const result = await executorClient.execute({
        tool: 'file_read',
        args: { path: filePath, max_bytes: Number(args.max_bytes ?? 65536) },
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.agentId ? 'agent' : 'human',
        executionId,
      })

      if (result.error) {
        return `Error: ${result.error}`
      }

      return result.output || '(no output)'
    },
  },

  {
    name: 'system_info',
    description: 'Show CPU, memory, disk usage, and uptime for the ORION management host',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(args: Record<string, unknown>, ctx?: { agentId?: string; userId?: string; actorType?: 'agent' | 'human' }) {
      console.log(`[localhost] system_info`)

      const executionId = randomUUID()
      const result = await executorClient.execute({
        tool: 'system_info',
        args: {},
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.agentId ? 'agent' : 'human',
        executionId,
      })

      if (result.error) {
        return `Error: ${result.error}`
      }

      return result.output || '(no output)'
    },
  },
] as const).map(t => ({ ...t, category: 'localhost' as const }))
