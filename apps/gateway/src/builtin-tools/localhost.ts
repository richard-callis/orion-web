import { randomUUID } from 'crypto'
import path from 'path'
import { executorClient } from '../executor-client.js'
import { logger } from '../lib/logger.js'

/**
 * File read allowlist — paths permitted via file_read.
 * Gateway enforces this as a defense-in-depth control;
 * executor also validates against its own allowlist.
 * Entries are either a directory prefix or an exact file.
 */
const FILE_READ_ALLOWLIST = [
  '/var/log',
  '/etc/hosts',
  '/proc/cpuinfo',
  '/proc/meminfo',
]

/**
 * Normalise with path.resolve and compare on path-segment boundaries, so
 * `/var/log/../../etc/shadow` (resolves to /etc/shadow) and `/var/logx`
 * (a sibling, not a child) are both rejected. A plain startsWith accepted both.
 */
export function isFileReadAllowed(p: string): boolean {
  if (!path.isAbsolute(p) || p.includes('\0')) return false
  const resolved = path.resolve(p)
  return FILE_READ_ALLOWLIST.some(allowed => resolved === allowed || resolved.startsWith(allowed + path.sep))
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

      const executionId = randomUUID()
      // L5: never log the command itself — it can carry secrets. The executor
      // records the (redacted) command in the ToolExecution row.
      logger.info({ executionId, actor: ctx?.agentId ?? ctx?.userId ?? 'unknown', length: command.length }, 'shell_exec requested')

      const result = await executorClient.execute({
        tool: 'shell_exec',
        args: { command },
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.actorType ?? (ctx?.agentId ? 'agent' : 'human'),
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

      if (!isFileReadAllowed(filePath)) {
        return `Error: path '${filePath}' is not in the allowlist`
      }
      const resolved = path.resolve(filePath)

      logger.info({ path: resolved }, 'file_read requested')

      const executionId = randomUUID()
      const result = await executorClient.execute({
        tool: 'file_read',
        args: { path: resolved, max_bytes: Number(args.max_bytes ?? 65536) },
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.actorType ?? (ctx?.agentId ? 'agent' : 'human'),
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
      const executionId = randomUUID()
      const result = await executorClient.execute({
        tool: 'system_info',
        args: {},
        actorId: (ctx?.agentId as string) || (ctx?.userId as string) || 'unknown',
        actorType: ctx?.actorType ?? (ctx?.agentId ? 'agent' : 'human'),
        executionId,
      })

      if (result.error) {
        return `Error: ${result.error}`
      }

      return result.output || '(no output)'
    },
  },
] as const).map(t => ({ ...t, category: 'localhost' as const }))
