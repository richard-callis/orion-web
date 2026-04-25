import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, statSync } from 'fs'

/**
 * Dangerous command patterns that should never be allowed in shell_exec.
 * SOC2: [H-005] Defense-in-depth for the localhost shell_exec tool.
 * Since shell_exec takes a full command string (not interpolated args),
 * we can't use quote(). Instead we block dangerous patterns.
 */
const DANGEROUS_PATTERNS = [
  /;\s*(rm|dd|chmod|chown|mkfs|fdisk|wipe|mke2fs|cfdisk|parted|sgdisk|hdparm|blkdiscard)\b/i,
  /&&\s*(rm|dd|chmod|chown|mkfs|fdisk|wipe|mke2fs|cfdisk|parted|sgdisk|hdparm|blkdiscard)\b/i,
  /\|\s*(rm|dd|chmod|chown|mkfs|fdisk|wipe|mke2fs|cfdisk|parted|sgdisk|hdparm|blkdiscard)\b/i,
  /\|\|\s*(rm|dd|chmod|chown|mkfs|fdisk|wipe|mke2fs|cfdisk|parted|sgdisk|hdparm|blkdiscard)\b/i,
  /&&\s*(curl|wget)\b/i,
  /;\s*(curl|wget)\b/i,
  />>\s*(\/etc\/|\/root\/|\/\.ssh\/)/i,
  />\s*\/etc\/(passwd|shadow|sudoers|crontab)/i,
  />\s*\/root\/\.ssh\/(authorized_keys|id_|known_hosts)/i,
  /\|\s*(nc|ncat|socat|netcat)\b/i,
  /\/proc\/(self|fs|sys)/i,
  /\/dev\/(sda|sdb|vda|vdb|nbd|loop|xvd)/i,
  /eval\b/,
  /source\b.*\/etc\//i,
  /base64\s+-[di]/i,
] as const

/**
 * Blocklist of shell metacharacters that could enable injection.
 * SOC2: [H-005] Comprehensive blocklist for shell_exec command input.
 * Note: The command IS shell syntax, so we can't quote it.
 * We block characters that enable subcommand injection.
 */
const SHELL_META_RE = /[;&|`$<>\\!{}()\[\]]/

/**
 * Check if a command string contains dangerous patterns.
 * Returns null if safe, or the reason it's blocked.
 */
function checkDangerous(cmd: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Blocked: command matches dangerous pattern '${pattern.source}'`
    }
  }
  return null
}

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

      // SOC2: [H-005] Check for shell metacharacters that could enable injection
      if (SHELL_META_RE.test(command)) {
        return 'Error: command contains disallowed shell metacharacters'
      }

      // SOC2: [H-005] Check for dangerous command patterns
      const dangerReason = checkDangerous(command)
      if (dangerReason) {
        return `Error: ${dangerReason}`
      }

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
