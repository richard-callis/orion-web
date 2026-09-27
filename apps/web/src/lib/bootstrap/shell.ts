import { spawn, type ChildProcess } from 'child_process'

// Every subprocess gets a hard deadline: ssh/scp/docker-swarm/helm steps can
// otherwise hang a bootstrap job forever (e.g. an unreachable host with no
// ConnectTimeout, or a helm --wait that never converges).
const QUIET_TIMEOUT_MS   = 2 * 60_000   // short probes (kubectl get, token reads)
const COMMAND_TIMEOUT_MS = 15 * 60_000  // installs/deploys (helm --wait, compose up)
const KILL_GRACE_MS      = 10_000       // SIGTERM → SIGKILL grace period
const MAX_QUIET_OUTPUT   = 1024 * 1024  // cap buffered output of runQuiet

/** SIGTERM the process, then SIGKILL it if it hasn't exited after the grace period. */
function killWithGrace(proc: ChildProcess): void {
  proc.kill('SIGTERM')
  const force = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }, KILL_GRACE_MS)
  force.unref()
}

/** Run a command and capture stdout+stderr without streaming to the caller. */
export function runQuiet(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number = QUIET_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let truncated = false
    let timedOut = false
    const append = (d: Buffer) => {
      if (truncated) return
      out += d.toString()
      if (out.length > MAX_QUIET_OUTPUT) {
        out = out.slice(0, MAX_QUIET_OUTPUT) + '\n[output truncated]'
        truncated = true
      }
    }
    const timer = setTimeout(() => { timedOut = true; killWithGrace(proc) }, timeoutMs)
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) resolve({ ok: false, out: `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s\n${out.trim()}` })
      else resolve({ ok: code === 0, out: out.trim() })
    })
    proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, out: err.message }) })
  })
}

export function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  onLog: (line: string) => void,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      onLog(`${cmd} exceeded ${Math.round(timeoutMs / 1000)}s — terminating`)
      killWithGrace(proc)
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog)
    })
    proc.stderr.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`))
      else if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
