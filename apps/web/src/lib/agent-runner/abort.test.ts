import { describe, it, expect } from 'vitest'
import { runSignal, describeRunnerError, isAbortErrorMessage, throwIfAborted, ABORT_ERROR_PREFIX } from './abort'

describe('runSignal', () => {
  it('fires when the parent (task-level) signal aborts', () => {
    const parent = new AbortController()
    const signal = runSignal(parent.signal, 60_000)
    expect(signal.aborted).toBe(false)
    parent.abort()
    expect(signal.aborted).toBe(true)
  })

  it('fires on its own timeout with no parent', async () => {
    const signal = runSignal(undefined, 5)
    await new Promise(r => setTimeout(r, 30))
    expect(signal.aborted).toBe(true)
  })
})

describe('describeRunnerError', () => {
  it('tags abort and timeout errors as terminal', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const abort = new DOMException('This operation was aborted', 'AbortError')
    // DOMException is an Error subclass in Node ≥17
    expect(isAbortErrorMessage(describeRunnerError(timeout))).toBe(true)
    expect(isAbortErrorMessage(describeRunnerError(abort))).toBe(true)
  })

  it('leaves ordinary errors untagged (they may still be transient)', () => {
    const msg = describeRunnerError(new Error('ECONNRESET'))
    expect(msg).toBe('ECONNRESET')
    expect(isAbortErrorMessage(msg)).toBe(false)
  })
})

describe('throwIfAborted', () => {
  it('throws an AbortError only once the signal has fired', () => {
    const c = new AbortController()
    expect(() => throwIfAborted(c.signal)).not.toThrow()
    expect(() => throwIfAborted(undefined)).not.toThrow()
    c.abort()
    try {
      throwIfAborted(c.signal)
      expect.unreachable()
    } catch (e) {
      expect(describeRunnerError(e).startsWith(ABORT_ERROR_PREFIX)).toBe(true)
    }
  })
})
