import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { createSSEStream } from '@/lib/sse'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

const POLL_INTERVAL_MS = 2_000
// M3 fix: 'done' is the actual terminal status in the DB; 'completed'/'cancelled' were
// wrong values that caused the stream to never close for finished tasks (resource leak).
const TERMINAL_STATES  = new Set(['done', 'failed', 'cancelled', 'completed'])

/**
 * GET /api/tasks/:id/stream
 *
 * Server-Sent Events stream for live task progress. Polls the DB every 2s
 * and emits three event types:
 *
 *  event: task_event  — a new TaskEvent row (tool_call, tool_result, text, status_change…)
 *  event: status      — the task's current status string (emitted on each status change)
 *  event: done        — task reached a terminal state; stream closes automatically
 *
 * Clients can pass `?after=<eventId>` to resume from a known position so they
 * don't replay events they've already processed.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // B4 fix: route had no auth — any caller could stream any task's events
  let caller: Awaited<ReturnType<typeof requireServiceAuth>>
  try {
    caller = await requireServiceAuth(req)
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }
  const isService = caller === null

  const taskId = params.id
  const afterParam = req.nextUrl.searchParams.get('after') ?? undefined

  // Verify the task exists before opening the stream
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, status: true, createdBy: true } })
  if (!task) {
    return new Response('Task not found', { status: 404 })
  }

  // SOC2: IDOR fix — verify the caller owns this task (or is admin/service)
  try {
    await assertCanModify(caller, isService, task.createdBy)
  } catch {
    return new Response('Forbidden', { status: 403 })
  }

  // If already terminal, send a single done event and close immediately
  if (TERMINAL_STATES.has(task.status)) {
    return createSSEStream((_send, close) => {
      _send('status', { status: task.status })
      _send('done',   { status: task.status })
      close()
      return () => {}
    })
  }

  return createSSEStream((send, close) => {
    let lastEventId  = afterParam
    let lastStatus   = task.status
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      try {
        // Fetch new events since the last one we sent
        const newEvents = await prisma.taskEvent.findMany({
          where: {
            taskId,
            ...(lastEventId ? { id: { gt: lastEventId } } : {}),
          },
          orderBy: { createdAt: 'asc' },
        })

        for (const ev of newEvents) {
          send('task_event', {
            id:        ev.id,
            eventType: ev.eventType,
            content:   ev.content,
            agentId:   ev.agentId,
            createdAt: ev.createdAt,
          })
          lastEventId = ev.id
        }

        // Check for status change
        const current = await prisma.task.findUnique({
          where: { id: taskId },
          select: { status: true },
        })
        if (!current) {
          // Task was deleted
          send('done', { status: 'deleted' })
          close()
          return
        }

        if (current.status !== lastStatus) {
          lastStatus = current.status
          send('status', { status: current.status })
        }

        if (TERMINAL_STATES.has(current.status)) {
          send('done', { status: current.status })
          close()
        }
      } catch {
        // DB hiccup — keep the stream alive, try again next tick
      }
    }

    // Initial poll immediately, then on interval
    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)

    // Cleanup function called on stream cancel / client disconnect
    return () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
  })
}
