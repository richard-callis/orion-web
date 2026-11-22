import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { writeFileSync } = vi.hoisted(() => ({ writeFileSync: vi.fn() }))
vi.mock('fs', () => ({ writeFileSync, default: { writeFileSync } }))
vi.mock('./log', () => ({ log: vi.fn(), err: vi.fn() }))

import { err } from './log'
import { HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS, STARTUP_GRACE_MS, MODEL_WAIT_MS, startHeartbeatWhenReady, stopHeartbeat } from './heartbeat'

const never = new Promise<void>(() => {})

beforeEach(() => {
  vi.useFakeTimers()
  writeFileSync.mockReset()
  vi.mocked(err).mockReset()
})
afterEach(() => {
  stopHeartbeat()
  vi.useRealTimers()
})

describe('startHeartbeatWhenReady', () => {
  it('waits out the startup grace even when the model is already settled', async () => {
    void startHeartbeatWhenReady(Promise.resolve())
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS - 1)
    expect(writeFileSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writeFileSync).toHaveBeenCalledWith(HEARTBEAT_FILE, expect.any(String))
  })

  it('waits for the model past the startup grace', async () => {
    let settle!: () => void
    void startHeartbeatWhenReady(new Promise<void>(r => { settle = r }))
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS * 3)
    expect(writeFileSync).not.toHaveBeenCalled()
    settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('stops waiting for a model that never settles', async () => {
    void startHeartbeatWhenReady(never)
    await vi.advanceTimersByTimeAsync(MODEL_WAIT_MS - 1)
    expect(writeFileSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('treats a failed model load as settled', async () => {
    void startHeartbeatWhenReady(Promise.reject(new Error('no model')))
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('keeps beating, and survives write failures (logged once per outage)', async () => {
    void startHeartbeatWhenReady(Promise.resolve())
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS)
    writeFileSync.mockImplementation(() => { throw new Error('ENOSPC') })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)
    expect(err).toHaveBeenCalledTimes(1)
    writeFileSync.mockReset()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    writeFileSync.mockImplementation(() => { throw new Error('ENOSPC') })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    expect(err).toHaveBeenCalledTimes(2) // a second outage is logged again
  })

  it('never beats twice as often when started again', async () => {
    void startHeartbeatWhenReady(Promise.resolve())
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS)
    void startHeartbeatWhenReady(Promise.resolve())
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS)
    writeFileSync.mockClear()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('stops beating once stopped', async () => {
    void startHeartbeatWhenReady(Promise.resolve())
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    stopHeartbeat()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('does not start after being stopped', async () => {
    void startHeartbeatWhenReady(Promise.resolve())
    stopHeartbeat()
    await vi.advanceTimersByTimeAsync(MODEL_WAIT_MS)
    expect(writeFileSync).not.toHaveBeenCalled()
  })
})
