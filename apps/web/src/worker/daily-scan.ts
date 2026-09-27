/**
 * Daily scheduled vulnerability scan — once a day at 02:00 server time.
 * Implemented as a guard inside an hourly tick (see scheduler.ts) so we don't
 * need a separate scheduler library and the timing self-heals across worker
 * restarts. lastDailyScanDate is persisted to DB so a restart between
 * 02:00-03:00 doesn't re-run the scan, and a restart that spans 02:00 doesn't
 * skip it. dailyScanInFlight prevents the startup catch-up and the hourly tick
 * from both passing the dateKey guard before either upserts the setting
 * (TOCTOU fix).
 */
import { prisma } from '@/lib/db'
import { runDailyScan } from '@/jobs/security-scan-vulns'
import { err } from './log'
import { isStopping } from './state'

let dailyScanInFlight = false

export async function runScheduledDailyScan(): Promise<void> {
  if (dailyScanInFlight || isStopping()) return
  dailyScanInFlight = true
  const now = new Date()
  const dateKey = now.toISOString().slice(0, 10)
  await prisma.systemSetting.findUnique({ where: { key: 'worker.lastDailyScanDate' } })
    .then(async row => {
      if (row?.value === dateKey) return
      const localhostEnv = await prisma.environment.findFirst({ where: { name: 'localhost' }, select: { id: true } }).catch(() => null)
      const scan = localhostEnv ? await prisma.vulnerabilityScan.create({
        data: { environmentId: localhostEnv.id, driver: 'trivy', status: 'running', triggeredBy: 'schedule', startedAt: new Date() },
      }).catch(() => null) : null
      try {
        const results = await runDailyScan(undefined, 'trivy', scan?.id)
        const totals = results.reduce(
          (acc, r) => ({
            findingsCreated: acc.findingsCreated + r.findingsCreated,
            findingsEscalated: acc.findingsEscalated + r.findingsEscalated,
            findingsFixed: acc.findingsFixed + r.findingsFixed,
          }),
          { findingsCreated: 0, findingsEscalated: 0, findingsFixed: 0 }
        )
        if (scan) {
          await prisma.vulnerabilityScan.update({
            where: { id: scan.id },
            data: { status: 'completed', completedAt: new Date(), ...totals },
          }).catch(() => {})
        }
        await prisma.systemSetting.upsert({
          where: { key: 'worker.lastDailyScanDate' },
          update: { value: dateKey },
          create: { key: 'worker.lastDailyScanDate', value: dateKey },
        })
      } catch (e) {
        err(`Daily vuln scan failed: ${e}`)
        if (scan) {
          await prisma.vulnerabilityScan.update({
            where: { id: scan.id },
            data: { status: 'failed', completedAt: new Date(), errorMessage: String(e) },
          }).catch(() => {})
        }
      }
    })
    .catch(e => err(`Daily scan guard failed: ${e}`))
    .finally(() => { dailyScanInFlight = false })
}

/** Startup catch-up: if the worker restarted and we missed 02:00, run the scan now. */
export function catchUpDailyScan(): void {
  const dateKey = new Date().toISOString().slice(0, 10)
  prisma.systemSetting.findUnique({ where: { key: 'worker.lastDailyScanDate' } })
    .then(row => { if (row?.value !== dateKey) void runScheduledDailyScan() })
    .catch(() => {})
}
