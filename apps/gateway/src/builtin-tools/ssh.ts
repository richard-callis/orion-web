import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync, readFileSync, existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'

const exec = promisify(execFile)

/**
 * SSH tool set — lets agents reach any node in the environment, not just the
 * management host. Implemented via the system `ssh`/`scp` binaries (execFile)
 * to match the existing kubectl/docker tooling pattern and avoid a native dep.
 *
 * Config (env):
 *   GATEWAY_SSH_KEY_PATH — path to a private key on disk, OR
 *   GATEWAY_SSH_KEY      — base64-encoded private key (written to a temp file)
 *   GATEWAY_SSH_USER     — username (default: root)
 */

const SSH_USER = process.env.GATEWAY_SSH_USER ?? 'root'

/** Resolve the SSH private key to a file path on disk. Returns the path and
 *  whether it is ephemeral (temp file the caller must clean up). */
function resolveKeyPath(): { path: string; ephemeral: boolean } | null {
  const keyPath = process.env.GATEWAY_SSH_KEY_PATH
  if (keyPath && existsSync(keyPath)) {
    return { path: keyPath, ephemeral: false }
  }
  const b64 = process.env.GATEWAY_SSH_KEY
  if (b64) {
    const tmp = `/tmp/orion-ssh-key-${randomUUID()}`
    writeFileSync(tmp, Buffer.from(b64, 'base64'))
    chmodSync(tmp, 0o600)
    return { path: tmp, ephemeral: true }
  }
  return null
}

/** Common, hardened ssh options. We intentionally do not prompt and fail fast. */
function sshBaseArgs(keyPath: string, timeoutSecs: number): string[] {
  return [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.min(timeoutSecs, 30)}`,
    '-o', 'PasswordAuthentication=no',
  ]
}

/** Run `ssh user@host <command>`. Returns combined stdout/stderr. */
async function sshExec(host: string, command: string, timeoutSecs: number): Promise<string> {
  const key = resolveKeyPath()
  if (!key) {
    return 'Error: no SSH key configured. Set GATEWAY_SSH_KEY_PATH or GATEWAY_SSH_KEY.'
  }
  const args = [
    ...sshBaseArgs(key.path, timeoutSecs),
    `${SSH_USER}@${host}`,
    '--',
    command,
  ]
  try {
    const { stdout, stderr } = await exec('ssh', args, { timeout: timeoutSecs * 1000, maxBuffer: 10 * 1024 * 1024 })
    return (stdout || '') + (stderr ? `\n${stderr}` : '')
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    if (err.killed) return `Error: ssh to ${host} timed out after ${timeoutSecs}s`
    const out = (err.stdout ?? '') + (err.stderr ?? '')
    return out.trim() || `Error: ${err.message ?? String(e)}`
  } finally {
    if (key.ephemeral) { try { unlinkSync(key.path) } catch { /* ignore */ } }
  }
}

export const sshTools = ([
  {
    name: 'ssh_exec',
    description: 'Execute a command on a remote host via SSH (reaches any node, not just the management host)',
    inputSchema: {
      type: 'object',
      properties: {
        host:    { type: 'string', description: 'Remote host IP or hostname' },
        command: { type: 'string', description: 'Command to run remotely' },
        timeout: { type: 'number', description: 'Max seconds to wait (default 30)' },
      },
      required: ['host', 'command'],
    },
    async execute(args: Record<string, unknown>) {
      const host = String(args.host ?? '').trim()
      const command = String(args.command ?? '').trim()
      if (!host) return 'Error: host is required'
      if (!command) return 'Error: command is required'
      const timeout = Number(args.timeout ?? 30)
      return sshExec(host, command, timeout)
    },
  },
  {
    name: 'ssh_copy_file',
    description: 'Copy a local file to a remote host via SCP',
    inputSchema: {
      type: 'object',
      properties: {
        host:       { type: 'string', description: 'Remote host IP or hostname' },
        localPath:  { type: 'string', description: 'Path to the local file' },
        remotePath: { type: 'string', description: 'Destination path on the remote host' },
      },
      required: ['host', 'localPath', 'remotePath'],
    },
    async execute(args: Record<string, unknown>) {
      const host = String(args.host ?? '').trim()
      const localPath = String(args.localPath ?? '').trim()
      const remotePath = String(args.remotePath ?? '').trim()
      if (!host || !localPath || !remotePath) return 'Error: host, localPath and remotePath are required'
      if (!existsSync(localPath)) return `Error: local file '${localPath}' does not exist`
      const key = resolveKeyPath()
      if (!key) return 'Error: no SSH key configured. Set GATEWAY_SSH_KEY_PATH or GATEWAY_SSH_KEY.'
      const args2 = [
        ...sshBaseArgs(key.path, 30),
        localPath,
        `${SSH_USER}@${host}:${remotePath}`,
      ]
      try {
        const { stdout, stderr } = await exec('scp', args2, { timeout: 60_000 })
        return (stdout || stderr || '').trim() || `Copied ${localPath} → ${host}:${remotePath}`
      } catch (e: unknown) {
        const err = e as { stderr?: string; message?: string }
        return `Error: ${err.stderr?.trim() || err.message || String(e)}`
      } finally {
        if (key.ephemeral) { try { unlinkSync(key.path) } catch { /* ignore */ } }
      }
    },
  },
  {
    name: 'ssh_get_file',
    description: 'Retrieve a file from a remote host and return its content',
    inputSchema: {
      type: 'object',
      properties: {
        host:       { type: 'string', description: 'Remote host IP or hostname' },
        remotePath: { type: 'string', description: 'Path to the file on the remote host' },
      },
      required: ['host', 'remotePath'],
    },
    async execute(args: Record<string, unknown>) {
      const host = String(args.host ?? '').trim()
      const remotePath = String(args.remotePath ?? '').trim()
      if (!host || !remotePath) return 'Error: host and remotePath are required'
      const key = resolveKeyPath()
      if (!key) return 'Error: no SSH key configured. Set GATEWAY_SSH_KEY_PATH or GATEWAY_SSH_KEY.'
      const tmp = `/tmp/orion-ssh-get-${randomUUID()}`
      const args2 = [
        ...sshBaseArgs(key.path, 30),
        `${SSH_USER}@${host}:${remotePath}`,
        tmp,
      ]
      try {
        await exec('scp', args2, { timeout: 60_000 })
        return readFileSync(tmp, 'utf8')
      } catch (e: unknown) {
        const err = e as { stderr?: string; message?: string }
        return `Error: ${err.stderr?.trim() || err.message || String(e)}`
      } finally {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        if (key.ephemeral) { try { unlinkSync(key.path) } catch { /* ignore */ } }
      }
    },
  },
  {
    name: 'ssh_node_debug',
    description: 'Collect a diagnostic bundle from a remote host: uptime, disk, memory, top processes, journalctl and dmesg tails',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Remote host IP or hostname' },
      },
      required: ['host'],
    },
    async execute(args: Record<string, unknown>) {
      const host = String(args.host ?? '').trim()
      if (!host) return 'Error: host is required'
      // Single SSH session running all probes; each tolerates failure.
      const script = [
        'echo "===== uptime ====="; uptime',
        'echo "===== df -h ====="; df -h',
        'echo "===== free -m ====="; free -m',
        'echo "===== top processes ====="; ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu | head -15',
        'echo "===== journalctl (tail 50) ====="; journalctl -n 50 --no-pager 2>/dev/null || echo "journalctl unavailable"',
        'echo "===== dmesg (tail 50) ====="; dmesg --ctime 2>/dev/null | tail -50 || dmesg 2>/dev/null | tail -50 || echo "dmesg unavailable"',
      ].join('; ')
      return sshExec(host, script, 60)
    },
  },
] as const).map(t => ({ ...t, category: 'ssh' as const }))
