/**
 * Cron-style task scheduler job.
 *
 * Runs every 60s (registered in worker.ts).
 * Finds enabled ScheduledTask records where nextRunAt <= now(),
 * creates a Task for each, then updates the schedule's lastRunAt / nextRunAt.
 */

import { prisma } from '@/lib/db'
import { nextRun } from '@/lib/cron'

function log(msg: string) { process.stdout.write(`[task-scheduler] ${msg}\n`) }
function err(msg: string) { process.stderr.write(`[task-scheduler] ERROR: ${msg}\n`) }

export async function runScheduler(): Promise<void> {
  const now = new Date()

  const due = await prisma.scheduledTask.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  if (due.length === 0) return

  log(`Found ${due.length} scheduled task(s) due`)

  for (const schedule of due) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const taskData: any = {
        title:       schedule.taskTitle,
        description: schedule.taskDesc ?? null,
        status:      'pending',
        priority:    'medium',
        assignedAgent: schedule.agentId,
        createdBy:   'scheduler',
      }

      if (schedule.taskMeta) {
        try { taskData.metadata = JSON.parse(schedule.taskMeta) } catch { /* ignore */ }
      }

      // Compute next run time
      const computedNextRun = nextRun(schedule.cronExpr, now)

      // Create the task and advance the schedule atomically so a crash
      // between the two writes can never cause a duplicate spawn on restart.
      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.task.create({ data: taskData })

        await tx.scheduledTask.update({
          where: { id: schedule.id },
          data: {
            lastRunAt:  now,
            lastTaskId: created.id,
            nextRunAt:  computedNextRun,
          },
        })

        return created
      })

      log(`Spawned task "${task.id}" for schedule "${schedule.name}" (agent: ${schedule.agent.name}), next run: ${computedNextRun.toISOString()}`)
    } catch (e) {
      err(`Failed to process schedule "${schedule.name}" (${schedule.id}): ${e}`)
    }
  }
}
