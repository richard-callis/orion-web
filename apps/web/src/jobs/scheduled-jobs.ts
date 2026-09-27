/**
 * Scheduled background jobs — registered by the worker process only.
 *
 * These used to be registered from the web server's instrumentation hook,
 * which runs once per web replica (and again on every restart), so every
 * replica fired its own cron + startup catch-up. The worker is the single
 * scheduler now, and every run is additionally deduplicated per period via
 * BackgroundJob.dedupeKey, so overlapping workers during a deploy are safe too.
 */

import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { startJobOnce, utcDateKey } from '@/lib/job-runner'
import { runMaintenanceTasks } from '@/lib/worker-tasks'
import { ensureSecurityRetentionJobScheduled } from './security-retention-daily'
import { ensureSecurityStaleCheckJobScheduled } from './security-stale-check'
import { ensureAuditExportJobScheduled } from './audit-export-daily'

const tasks: ScheduledTask[] = []

function startAuditRetention(title: string): void {
  startJobOnce('audit-retention-daily', title, `audit-retention-daily:${utcDateKey()}`, {}, async (log) => {
    const result = await runMaintenanceTasks()
    if (!result.success) throw new Error(result.errors.join('; '))
    await log('Audit log retention complete')
  }).catch(err => console.error('[audit-retention] run failed to start:', err))
}

/**
 * SOC2 AUDIT-001: daily audit-log retention (lib/worker-tasks.ts). Runs at
 * 03:00 UTC, after the 02:00 export; cleanupAuditLogs() itself refuses to
 * delete anything unless an export succeeded in the last 25h.
 */
function ensureAuditRetentionJobScheduled(): ScheduledTask {
  const task = cron.schedule('0 3 * * *', () => startAuditRetention('Audit log retention (AUDIT-001)'), { timezone: 'UTC' })
  startAuditRetention('Audit log retention (AUDIT-001): startup catch-up')
  return task
}

export function registerScheduledJobs(): void {
  if (tasks.length > 0) return
  const register = (name: string, fn: () => ScheduledTask | null) => {
    try {
      const task = fn()
      if (task) tasks.push(task)
    } catch (e) {
      // One job failing to register must not stop the others.
      console.error(`[scheduled-jobs] Failed to register ${name}:`, e)
    }
  }
  register('security-retention-daily', ensureSecurityRetentionJobScheduled)
  register('security-stale-check', ensureSecurityStaleCheckJobScheduled)
  register('audit-export-daily', ensureAuditExportJobScheduled)
  register('audit-retention-daily', ensureAuditRetentionJobScheduled)
}

export function stopScheduledJobs(): void {
  for (const task of tasks) {
    try { task.stop() } catch { /* already stopped */ }
  }
  tasks.length = 0
}
