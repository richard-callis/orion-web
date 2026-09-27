/**
 * runTask phase sequencing: every early exit stops the pipeline, errors go to
 * handleFailure, and the budget reservation + running-set entry are always
 * released.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  buildTaskContext: vi.fn(),
  budgetGate: vi.fn(),
  maybeFederate: vi.fn(),
  executeRun: vi.fn(),
  pauseForPlanApproval: vi.fn(),
  finalizeSuccess: vi.fn(),
  handleFailure: vi.fn(),
  releaseBudgetReservation: vi.fn(async () => {}),
  heartbeatTask: vi.fn(async () => true),
}))

vi.mock('./context', () => ({ buildTaskContext: m.buildTaskContext }))
vi.mock('./budget', () => ({ budgetGate: m.budgetGate }))
vi.mock('./federation', () => ({ maybeFederate: m.maybeFederate }))
vi.mock('./execute', () => ({ executeRun: m.executeRun }))
vi.mock('./finalize', () => ({ pauseForPlanApproval: m.pauseForPlanApproval, finalizeSuccess: m.finalizeSuccess }))
vi.mock('./failure', () => ({ handleFailure: m.handleFailure }))
vi.mock('@/lib/token-budget', () => ({ releaseBudgetReservation: m.releaseBudgetReservation }))
vi.mock('@/workers/task-claim', () => ({ heartbeatTask: m.heartbeatTask, TASK_HEARTBEAT_INTERVAL_MS: 60_000 }))

import { runTask } from './run-task'
import { runningTasks } from '../state'
import type { RunAccounting } from './types'

const prepared = { taskId: 't1' }
const run = { pausedForApproval: false, outputText: 'ok', toolsUsed: [], conversationId: 'c1', featureRoomId: null }

/** buildTaskContext stub that also records the agent + a reservation, like the real phases. */
function withReservation() {
  m.buildTaskContext.mockImplementation(async (_id: string, acc: RunAccounting) => { acc.agentId = 'a1'; return prepared })
  m.budgetGate.mockImplementation(async (_p: unknown, acc: RunAccounting) => { acc.budgetReservationTokens = 5000; return true })
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.releaseBudgetReservation.mockResolvedValue(undefined)
  m.heartbeatTask.mockResolvedValue(true)
  withReservation()
  m.maybeFederate.mockResolvedValue(false)
  m.executeRun.mockResolvedValue(run)
})

describe('runTask', () => {
  it('runs the full pipeline on success and releases the reservation', async () => {
    await runTask('t1')
    expect(m.executeRun).toHaveBeenCalledWith(prepared, expect.any(Object), expect.any(AbortSignal))
    expect(m.finalizeSuccess).toHaveBeenCalledWith(prepared, run, expect.any(Object), expect.any(Number))
    expect(m.pauseForPlanApproval).not.toHaveBeenCalled()
    expect(m.handleFailure).not.toHaveBeenCalled()
    expect(m.releaseBudgetReservation).toHaveBeenCalledWith('a1', 5000)
    expect(runningTasks.has('t1')).toBe(false)
  })

  it('stops when the task cannot run here', async () => {
    m.buildTaskContext.mockResolvedValue(null)
    await runTask('t1')
    expect(m.budgetGate).not.toHaveBeenCalled()
    expect(m.releaseBudgetReservation).not.toHaveBeenCalled()
  })

  it('stops when the budget gate defers/pauses', async () => {
    m.budgetGate.mockResolvedValue(false)
    await runTask('t1')
    expect(m.maybeFederate).not.toHaveBeenCalled()
    expect(m.executeRun).not.toHaveBeenCalled()
  })

  it('stops after federating, still releasing the reservation', async () => {
    m.maybeFederate.mockResolvedValue(true)
    await runTask('t1')
    expect(m.executeRun).not.toHaveBeenCalled()
    expect(m.releaseBudgetReservation).toHaveBeenCalledWith('a1', 5000)
  })

  it('pauses for plan approval instead of finalizing', async () => {
    const paused = { ...run, pausedForApproval: true }
    m.executeRun.mockResolvedValue(paused)
    await runTask('t1')
    expect(m.pauseForPlanApproval).toHaveBeenCalledWith(prepared, paused, expect.any(Object))
    expect(m.finalizeSuccess).not.toHaveBeenCalled()
  })

  it('routes errors from any phase to handleFailure with the accounting', async () => {
    const boom = new Error('runner exploded')
    m.executeRun.mockImplementation(async (_p: unknown, acc: RunAccounting) => {
      acc.totalInputTokens = 10
      throw boom
    })
    await runTask('t1')
    expect(m.handleFailure).toHaveBeenCalledWith('t1', boom, expect.objectContaining({ agentId: 'a1', totalInputTokens: 10 }))
    expect(m.releaseBudgetReservation).toHaveBeenCalledWith('a1', 5000)
    expect(runningTasks.has('t1')).toBe(false)
  })

  it('refreshes the heartbeat before running', async () => {
    await runTask('t1')
    expect(m.heartbeatTask).toHaveBeenCalledWith('t1')
  })
})
