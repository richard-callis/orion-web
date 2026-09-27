import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EXEC_CWD, parseArgv, isBlockedPath, resolveRealPath } from './command-policy.js'

/** Output kept per stream; anything beyond this is dropped and a marker appended. */
export const MAX_OUTPUT_BYTES = 256 * 1024
/** Total output after which a runaway process is killed rather than left to the timeout. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024
/** Exit code reported for a timeout (same convention as coreutils `timeout`). */
export const TIMEOUT_EXIT_CODE = 124

// /proc and /sys are never readable (they expose the executor's own environment), so entries
// under them are dropped from the allowlist rather than silently failing on every read.
// system_info already reports what /proc/cpuinfo and /proc/meminfo used to be read for.
export const FILE_READ_ALLOWLIST = (process.env.FILE_READ_ALLOWLIST || '/var/log,/etc/hosts')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean)
  .filter(p => {
    const unreadable = isBlockedPath(p)
    if (unreadable) console.warn(`FILE_READ_ALLOWLIST entry '${p}' is under a blocked path and will be ignored`)
    return !unreadable
  })

// Children get a minimal environment so a command can't print the executor's tokens via `env`.
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ,
    HOME: EXEC_CWD,
  }
}

interface ExecuteOptions {
  timeoutMs?: number
  /** Permit `/bin/sh -c` for commands that can't be tokenised. Only for human-approved runs. */
  allowShell?: boolean
}

export interface ExecuteResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

class OutputBuffer {
  private chunks: Buffer[] = []
  private kept = 0
  seen = 0

  push(chunk: Buffer) {
    this.seen += chunk.length
    if (this.kept >= MAX_OUTPUT_BYTES) return
    const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - this.kept)
    this.chunks.push(slice)
    this.kept += slice.length
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf-8')
    return this.seen > this.kept ? `${text}\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]` : text
  }
}

export function truncateOutput(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  return `${Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString('utf-8')}\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`
}

/**
 * Run a process in its own process group so a timeout can kill everything it started, not just
 * the direct child. Always resolves; exitCode is always a number.
 */
export function runProcess(file: string, args: string[], timeoutMs: number): Promise<ExecuteResult> {
  const startTime = Date.now()
  return new Promise(resolve => {
    const stdout = new OutputBuffer()
    const stderr = new OutputBuffer()
    let note = ''
    let settled = false

    const child = spawn(file, args, {
      cwd: EXEC_CWD,
      env: childEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Group already gone.
      }
    }

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const err = stderr.toString()
      resolve({
        stdout: stdout.toString(),
        stderr: note ? (err ? `${err}\n${note}` : note) : err,
        exitCode,
        durationMs: Date.now() - startTime,
      })
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      note = `[timed out after ${timeoutMs}ms; process group killed]`
      killGroup()
    }, timeoutMs)

    const onData = (buf: OutputBuffer) => (chunk: Buffer) => {
      buf.push(chunk)
      if (stdout.seen + stderr.seen > MAX_BUFFER_BYTES && !note) {
        note = `[killed: output exceeded ${MAX_BUFFER_BYTES} bytes]`
        killGroup()
      }
    }
    child.stdout.on('data', onData(stdout))
    child.stderr.on('data', onData(stderr))

    child.on('error', (err: NodeJS.ErrnoException) => {
      note = err.message
      finish(err.code === 'ENOENT' ? 127 : 126)
    })

    child.on('close', (code, signal) => {
      if (timedOut) return finish(TIMEOUT_EXIT_CODE)
      if (typeof code === 'number') return finish(code)
      const signum = signal ? os.constants.signals[signal] ?? 0 : 0
      finish(signal ? 128 + signum : 1)
    })
  })
}

export class Sandbox {
  async execute(
    tool: string,
    args: Record<string, unknown>,
    options: ExecuteOptions = {}
  ): Promise<ExecuteResult> {
    const { timeoutMs = 30000, allowShell = false } = options

    switch (tool) {
      case 'shell_exec':
        return this.executeShell(String(args.command ?? ''), timeoutMs, allowShell)
      case 'file_read':
        return this.readFile(String(args.path ?? ''))
      case 'system_info':
        return this.getSystemInfo()
      default:
        throw new Error(`Unknown tool: ${tool}`)
    }
  }

  private async executeShell(command: string, timeoutMs: number, allowShell: boolean): Promise<ExecuteResult> {
    // Run as argv whenever the command tokenises cleanly — no shell means no injection surface.
    // Only a human-approved command that genuinely needs shell syntax gets `/bin/sh -c`.
    const argv = parseArgv(command)
    if (argv) return runProcess(argv[0], argv.slice(1), timeoutMs)
    if (!allowShell) {
      return { stdout: '', stderr: 'Error: command requires a shell and was not approved', exitCode: 126, durationMs: 0 }
    }
    return runProcess('/bin/sh', ['-c', command], timeoutMs) // lgtm[js/command-line-injection] human-approved
  }

  private async readFile(rawPath: string): Promise<ExecuteResult> {
    const startTime = Date.now()
    // Resolve `..` AND symlinks before comparing: '/var/log/../../etc/shadow' and a symlink
    // inside /var/log pointing elsewhere must both be judged by their real target.
    const resolved = resolveRealPath(path.resolve(rawPath), '/')

    const isAllowed = FILE_READ_ALLOWLIST.some(allowed => {
      const normalizedAllowed = resolveRealPath(allowed, '/')
      return resolved === normalizedAllowed || resolved.startsWith(normalizedAllowed + '/')
    })
    if (!isAllowed) {
      return { stdout: '', stderr: `Error: path '${rawPath}' (resolved: '${resolved}') is not in the allowlist`, exitCode: 1, durationMs: 0 }
    }
    // Defence in depth: never read blocked locations even if an allowlist entry leads there.
    if (isBlockedPath(resolved, false, '/')) {
      return { stdout: '', stderr: `Error: reading '${resolved}' is not permitted`, exitCode: 1, durationMs: 0 }
    }
    try {
      const handle = await fs.promises.open(resolved, 'r')
      try {
        const buf = Buffer.alloc(MAX_OUTPUT_BYTES + 1)
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        return {
          stdout: truncateOutput(buf.subarray(0, bytesRead).toString('utf-8')),
          stderr: '',
          exitCode: 0,
          durationMs: Date.now() - startTime,
        }
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Date.now() - startTime,
      }
    }
  }

  private async getSystemInfo(): Promise<ExecuteResult> {
    const startTime = Date.now()
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalmem: os.totalmem(),
      freemem: os.freemem(),
    }
    return {
      stdout: JSON.stringify(info, null, 2),
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - startTime,
    }
  }
}

export const sandbox = new Sandbox()
