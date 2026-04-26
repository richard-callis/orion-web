import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'

export const dynamic = 'force-dynamic'

export async function GET() {
  const stateFile = process.env.WORKER_STATE_FILE ?? '/tmp/orion-worker-state.json'

  let worker: Record<string, unknown> | null = null
  try {
    if (existsSync(stateFile)) {
      worker = JSON.parse(readFileSync(stateFile, 'utf8'))
    }
  } catch {
    // State file unreadable — worker may not be running
  }

  if (worker) {
    const uptimeSec = Math.round((worker.uptime as number) / 1000)
    const tasksRunning = worker.tasksRunning as number
    const lastPollSec = Math.round((Date.now() - (worker.lastPoll as number)) / 1000)
    const isStale = (worker.shuttingDown as boolean) || lastPollSec > 60

    return NextResponse.json(
      {
        status: isStale ? 'degraded' : 'ok',
        worker: {
          uptime: `${uptimeSec}s`,
          tasksRunning,
          lastPollSecondsAgo: lastPollSec,
          shuttingDown: worker.shuttingDown as boolean,
        },
      },
      { status: isStale ? 503 : 200 },
    )
  }

  // No state file — worker not running
  return NextResponse.json(
    { status: 'error', worker: { message: 'Orchestrator not running' } },
    { status: 503 },
  )
}
