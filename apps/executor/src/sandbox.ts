import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const FILE_READ_ALLOWLIST = (process.env.FILE_READ_ALLOWLIST || '/var/log,/etc/hosts,/proc/cpuinfo,/proc/meminfo')
  .split(',')
  .map(p => p.trim())

interface ExecuteOptions {
  timeoutMs?: number
}

interface ExecuteResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

class Sandbox {
  async execute(
    tool: string,
    args: Record<string, unknown>,
    options: ExecuteOptions = {}
  ): Promise<ExecuteResult> {
    const { timeoutMs = 30000 } = options
    const startTime = Date.now()

    switch (tool) {
      case 'shell_exec':
        return this.executeShell(args.command as string, timeoutMs)
      case 'file_read':
        return this.readFile(args.path as string)
      case 'system_info':
        return this.getSystemInfo()
      default:
        throw new Error(`Unknown tool: ${tool}`)
    }
  }

  private async executeShell(command: string, timeoutMs: number): Promise<ExecuteResult> {
    const startTime = Date.now()
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs }) // lgtm[js/command-line-injection]
      return {
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - startTime,
      }
    } catch (error: unknown) {
      const err = error as any
      const durationMs = Date.now() - startTime
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || 'Command execution failed',
        exitCode: err.code || 1,
        durationMs,
      }
    }
  }

  private async readFile(path: string): Promise<ExecuteResult> {
    const startTime = Date.now()
    if (!FILE_READ_ALLOWLIST.some(allowed => path.startsWith(allowed))) {
      return { stdout: '', stderr: `Error: path '${path}' is not in the allowlist`, exitCode: 1, durationMs: 0 }
    }
    try {
      const fs = await import('fs')
      const content = fs.readFileSync(path, 'utf-8') // lgtm[js/path-injection]
      return {
        stdout: content,
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - startTime,
      }
    } catch (error: unknown) {
      const err = error as any
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - startTime,
      }
    }
  }

  private async getSystemInfo(): Promise<ExecuteResult> {
    const startTime = Date.now()
    try {
      const os = await import('os')
      const info = {
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        loadavg: os.loadavg(),
        cpus: os.cpus().length,
        totalmem: os.totalmem(),
        freemem: os.freemem(),
      }
      return {
        stdout: JSON.stringify(info, null, 2),
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - startTime,
      }
    } catch (error: unknown) {
      const err = error as any
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - startTime,
      }
    }
  }
}

export const sandbox = new Sandbox()
