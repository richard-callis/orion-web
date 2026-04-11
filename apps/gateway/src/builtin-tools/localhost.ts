import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, statSync } from 'fs'

const exec = promisify(execFile)

async function sh(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec(cmd, args, { timeout: timeoutMs })
  return stdout || stderr
}

export const localhostTools = [
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
    async execute(args: Record<string, unknown>) {
      const command = String(args.command ?? '').trim()
      if (!command) return 'Error: command is required'
      const timeoutMs = Math.min((Number(args.timeout_secs ?? 30)) * 1000, 120_000)

      console.log(`[localhost] shell_exec: ${command}`)
      const { stdout, stderr } = await exec('sh', ['-c', command], { timeout: timeoutMs })
      return (stdout + stderr).trim() || '(no output)'
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
    async execute(args: Record<string, unknown>) {
      const filePath = String(args.path ?? '').trim()
      if (!filePath) return 'Error: path is required'
      const maxBytes = Math.min(Number(args.max_bytes ?? 65536), 1_048_576) // cap at 1MB

      try {
        const stat = statSync(filePath)
        const content = readFileSync(filePath)
        const slice = content.slice(0, maxBytes)
        const truncated = content.length > maxBytes
        return `[${filePath}] (${stat.size} bytes${truncated ? `, showing first ${maxBytes}` : ''})\n\n${slice.toString('utf8')}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'system_info',
    description: 'Show CPU, memory, disk usage, and uptime for the ORION management host',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const [uptime, memory, disk] = await Promise.allSettled([
        sh('uptime', []),
        sh('free', ['-h']),
        sh('df', ['-h', '--output=target,size,used,avail,pcent', '-x', 'tmpfs', '-x', 'devtmpfs']),
      ])

      const lines: string[] = ['=== System Info ===']
      lines.push('')
      lines.push('-- Uptime --')
      lines.push(uptime.status === 'fulfilled' ? uptime.value.trim() : `Error: ${uptime.reason}`)
      lines.push('')
      lines.push('-- Memory --')
      lines.push(memory.status === 'fulfilled' ? memory.value.trim() : `Error: ${memory.reason}`)
      lines.push('')
      lines.push('-- Disk --')
      lines.push(disk.status === 'fulfilled' ? disk.value.trim() : `Error: ${disk.reason}`)

      return lines.join('\n')
    },
  },
]
