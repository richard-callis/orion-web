/**
 * ORION Orchestrator — runs alongside the Next.js server.
 *
 * Polls for tasks assigned to AI agents and executes them using the
 * appropriate runner (Claude or Ollama), routing tool calls through the
 * environment's gateway.
 *
 * Started by entrypoint.sh (node worker.js). Owns all scheduled/background
 * jobs so they run once per deployment rather than once per web replica.
 *
 * Layout (src/worker/):
 *   task/       runTask and its phases (context, budget, federation, execute,
 *               finalize, failure)
 *   scheduler   periodic jobs table + shared in-flight guard
 *   poll, watchers, recovery, gitops-sync, approval-escalation,
 *   federation-poller, daily-scan — the jobs themselves
 */

import { prisma } from './lib/db'
import { startDream, stopDream } from './lib/dream'
import { healUnencryptedSettings } from './lib/encrypted-settings'
import { recoverStalledJobs } from './lib/job-runner'
import { registerScheduledJobs, stopScheduledJobs } from './jobs/scheduled-jobs'
import { WORKER_ID } from './workers/task-claim'
import { log, err } from './worker/log'
import { markStopping, isStopping, runningTasks, runningWatchers, workerConfig } from './worker/state'
import { startScheduler, stopScheduler } from './worker/scheduler'
import { recoverStuckTasks } from './worker/recovery'
import { pollOnce } from './worker/poll'
import { catchUpDailyScan } from './worker/daily-scan'

async function loadWorkerSettings(): Promise<void> {
  // Load tunable settings from DB so operators can change them without redeploying
  const [pollSetting, concurrentSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'worker.pollIntervalMs' } }).catch(() => null),
    prisma.systemSetting.findUnique({ where: { key: 'worker.maxConcurrent' } }).catch(() => null),
  ])
  if (pollSetting?.value) {
    const v = parseInt(String(pollSetting.value), 10)
    if (v >= 1000 && v <= 300_000) workerConfig.pollIntervalMs = v
  }
  if (concurrentSetting?.value) {
    const v = parseInt(String(concurrentSetting.value), 10)
    if (v >= 1 && v <= 20) workerConfig.maxConcurrent = v
  }
}

async function main() {
  log('Orchestrator starting…')

  // Give the web container's entrypoint time to finish `prisma migrate deploy`
  await new Promise(resolve => setTimeout(resolve, 5_000))

  await loadWorkerSettings()
  log(`Polling every ${workerConfig.pollIntervalMs / 1000}s, max ${workerConfig.maxConcurrent} concurrent tasks`)

  // Self-heal any SystemSetting rows that should be encrypted but aren't —
  // catches legacy/manually-edited plaintext before some unrelated feature
  // fails deep in a tool call, far removed from the actual bad write.
  await healUnencryptedSettings().catch(e => err(`Encrypted-settings heal failed: ${e}`))

  // Recover any tasks that were in_progress when the worker last crashed
  await recoverStuckTasks().catch(e => err(`Startup recovery failed: ${e}`))

  // Background jobs orphaned by a dead process (stale heartbeat) → failed.
  await recoverStalledJobs().catch(e => err(`Background job recovery failed: ${e}`))

  // Scheduled background jobs (security retention, source stale-check, audit
  // export + AUDIT-001 retention). Registered here — not in the web server's
  // instrumentation hook — so they run once per deployment instead of once
  // per web replica, and deduplicated per period via BackgroundJob.dedupeKey.
  registerScheduledJobs()

  // Initial poll
  await pollOnce().catch(e => err(`Initial poll failed: ${e}`))

  // Dream — memory consolidation covers three phases:
  //   extraction (every 2h): scans recent chat messages + task events, extracts durable
  //     facts/lessons as llm-context notes with [[wikilinks]], immediately embeds them
  //     for vector search retrieval.
  //   synthesis (every 12h): identifies missing "hub" notes that connect clusters of
  //     related specific notes into a coherent knowledge graph.
  //   pruning (every 24h): reviews notes older than 7 days, flags or deletes stale ones.
  //   model: configurable via dream.model SystemSetting (falls back to system default).
  startDream()

  // Daily vuln scan: run now if the worker restarted and missed 02:00.
  catchUpDailyScan()

  // Every periodic job — task poll, watchers, pollers, recovery, escalation,
  // drift detection, federation — see worker/scheduler.ts.
  startScheduler()
}

process.on('unhandledRejection', (reason, promise) => {
  process.stderr.write(`[orchestrator] Unhandled rejection at: ${promise}\nReason: ${reason}\n`)
})
process.on('uncaughtException', (e) => {
  process.stderr.write(`[orchestrator] Uncaught exception: ${e.message}\n${e.stack ?? ''}\n`)
  process.exit(1)
})

main().catch(e => { err(`Fatal: ${e}`); process.exit(1) })

// Graceful shutdown on SIGTERM (container stop / redeploy).
// Stop claiming new work and clear every periodic timer first, then wait up
// to 60s for in-flight tasks to drain. Tasks still running at the deadline
// stop heartbeating and are re-queued by recoverStuckTasks on the next start.
async function shutdown(signal: string): Promise<void> {
  if (isStopping()) return
  markStopping()
  log(`Received ${signal} — stopping schedulers and draining in-flight tasks (max 60s)...`)
  stopScheduler()
  stopScheduledJobs()
  stopDream()
  const deadline = Date.now() + 60_000
  while ((runningTasks.size > 0 || runningWatchers.size > 0) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (runningTasks.size > 0) err(`Shutdown: ${runningTasks.size} task(s) still running at deadline — exiting anyway`)
  log(`Shutdown complete (${WORKER_ID})`)
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })
