/**
 * Abort/timeout plumbing shared by the agent runners.
 *
 * Runners combine the caller's task-level signal (TaskRunContext.signal) with
 * their own per-request timeout, and tag abort/timeout failures with
 * ABORT_ERROR_PREFIX so the worker can treat them as terminal. Retrying a run
 * that was cut off mid-way would re-execute tools that may already have had
 * side effects, so these must never be classified as transient.
 */

export const ABORT_ERROR_PREFIX = '[aborted]'

/** Signal that fires on the caller's abort or after `timeoutMs`, whichever comes first. */
export function runSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

export function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Error text for a runner `error` event; abort/timeout failures get the terminal prefix. */
export function describeRunnerError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return isAbortLike(err) ? `${ABORT_ERROR_PREFIX} ${msg}` : msg
}

export function isAbortErrorMessage(msg: string): boolean {
  return msg.startsWith(ABORT_ERROR_PREFIX)
}

/** Throw a tagged abort error if the caller has already cancelled the run. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const e = new Error('Run cancelled by caller')
    e.name = 'AbortError'
    throw e
  }
}
