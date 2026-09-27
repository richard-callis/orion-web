/**
 * Central subprocess helper for gateway tools and watchers.
 *
 * - Always execFile (argv array, no shell).
 * - Explicit maxBuffer (16 MB) — Node's 1 MB default made large outputs such as
 *   `kubectl get -A -o json` fail with ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
 * - Output returned to callers/agents is truncated (default 256 KB) with a
 *   visible marker so a huge result can't blow up memory, logs or LLM context.
 * - Optional stdin input (used to pipe manifests into `kubectl apply -f -`).
 */

import { execFile } from 'child_process'

export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024
export const DEFAULT_MAX_OUTPUT = 256 * 1024

export interface RunOptions {
  timeoutMs?: number
  /** Bytes buffered from the child before it is killed (default 16 MB). */
  maxBuffer?: number
  /** Characters kept in the returned stdout/stderr (default 256 KB). 0 = no truncation. */
  maxOutput?: number
  /** Data written to the child's stdin. */
  input?: string
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  stdout: string
  stderr: string
}

export function truncateOutput(s: string, max = DEFAULT_MAX_OUTPUT): string {
  if (!max || s.length <= max) return s
  return `${s.slice(0, max)}\n[truncated — ${s.length - max} more characters omitted]`
}

/**
 * Binaries the gateway may execute. Callers pass literal names; this guards
 * against a future caller ever routing a user-controlled value into `bin`.
 * (`sh` is used only for `command -v` probes and admin-defined shell tools,
 * whose arguments are single-quoted by tool-runner.)
 */
export const ALLOWED_BINARIES = new Set(['kubectl', 'helm', 'docker', 'talosctl', 'velero', 'trivy', 'hostname', 'sh'])

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (!ALLOWED_BINARIES.has(bin)) {
    return Promise.reject(new Error(`run(): '${bin}' is not an allowed binary`))
  }
  const { timeoutMs = 30_000, maxBuffer = DEFAULT_MAX_BUFFER, maxOutput = DEFAULT_MAX_OUTPUT, input, env } = opts
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer, env: env ?? process.env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          // Keep the (truncated) streams on the error for callers that want them.
          const e = err as Error & { stdout?: string; stderr?: string; code?: unknown }
          e.stdout = truncateOutput(String(stdout ?? ''), maxOutput)
          e.stderr = truncateOutput(String(stderr ?? ''), maxOutput)
          reject(e)
          return
        }
        resolve({
          stdout: truncateOutput(String(stdout ?? ''), maxOutput),
          stderr: truncateOutput(String(stderr ?? ''), maxOutput),
        })
      },
    )
    if (input !== undefined) {
      child.stdin?.on('error', () => { /* child exited early — surfaced via callback */ })
      child.stdin?.end(input)
    }
  })
}

/** Convenience: run and return stdout, falling back to stderr (the pattern every tool used). */
export async function runOut(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout, stderr } = await run(bin, args, opts)
  return stdout || stderr
}
