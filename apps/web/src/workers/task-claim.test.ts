/**
 * Atomic task claiming (review finding: tasks could run twice).
 *
 * The Prisma mock implements updateMany as a real compare-and-set over an
 * in-memory row, with an await between the read and the write so concurrent
 * claims genuinely interleave — the same shape as two workers racing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = {
  id: string
  status: string
  claimedBy: string | null
  claimedAt: Date | null
  heartbeatAt: Date | null
}

const rows = new Map<string, Row>()

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v)
}

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        // Postgres evaluates the WHERE and applies the SET atomically per row;
        // yield first so racing callers are all "in flight" together.
        await Promise.resolve()
        const row = rows.get(where.id as string)
        if (!row || !matches(row, where)) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
  },
}))

import {
  claimTask,
  heartbeatTask,
  releaseTaskClaim,
  staleInProgressWhere,
  TASK_HEARTBEAT_STALE_MS,
} from './task-claim'

beforeEach(() => {
  rows.clear()
  rows.set('t1', { id: 't1', status: 'pending', claimedBy: null, claimedAt: null, heartbeatAt: null })
})

describe('claimTask', () => {
  it('lets exactly one of several racing workers claim a pending task', async () => {
    const results = await Promise.all([
      claimTask('t1', 'worker-a'),
      claimTask('t1', 'worker-b'),
      claimTask('t1', 'worker-c'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = ['worker-a', 'worker-b', 'worker-c'][results.indexOf(true)]
    const row = rows.get('t1')!
    expect(row.status).toBe('in_progress')
    expect(row.claimedBy).toBe(winner)
    expect(row.claimedAt).toBeInstanceOf(Date)
    expect(row.heartbeatAt).toBeInstanceOf(Date)
  })

  it('refuses to claim a task that is not pending', async () => {
    rows.get('t1')!.status = 'in_progress'
    expect(await claimTask('t1', 'worker-a')).toBe(false)
    expect(rows.get('t1')!.claimedBy).toBeNull()
  })

  it('refuses to claim a task that does not exist', async () => {
    expect(await claimTask('missing', 'worker-a')).toBe(false)
  })
})

describe('heartbeatTask / releaseTaskClaim', () => {
  it('only the owning worker can heartbeat or release a claim', async () => {
    await claimTask('t1', 'worker-a')
    expect(await heartbeatTask('t1', 'worker-b')).toBe(false)
    expect(await heartbeatTask('t1', 'worker-a')).toBe(true)

    await releaseTaskClaim('t1', 'worker-b')
    expect(rows.get('t1')!.status).toBe('in_progress')

    await releaseTaskClaim('t1', 'worker-a')
    expect(rows.get('t1')).toMatchObject({ status: 'pending', claimedBy: null, heartbeatAt: null })
    // Released task can be claimed again.
    expect(await claimTask('t1', 'worker-b')).toBe(true)
  })
})

describe('staleInProgressWhere', () => {
  it('targets stale heartbeats, and legacy rows by updatedAt only when no heartbeat exists', () => {
    const now = new Date('2026-09-26T12:00:00Z')
    const legacyCutoff = new Date('2026-09-26T11:30:00Z')
    expect(staleInProgressWhere(now, legacyCutoff)).toEqual({
      status: 'in_progress',
      OR: [
        { heartbeatAt: { lt: new Date(now.getTime() - TASK_HEARTBEAT_STALE_MS) } },
        { heartbeatAt: null, updatedAt: { lt: legacyCutoff } },
      ],
    })
  })
})
