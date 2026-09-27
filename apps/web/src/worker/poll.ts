import { prisma } from '@/lib/db'
import { claimTask } from '@/workers/task-claim'
import { err } from './log'
import { isStopping, runningTasks, workerConfig } from './state'
import { runTask } from './task/run-task'

let runningPoll = false

// Upper bound on candidates examined per poll. Dependency gating happens in
// memory, so this is well above MAX_CONCURRENT to avoid starving runnable tasks
// behind a long run of blocked ones.
const POLL_CANDIDATE_LIMIT = 200

export async function pollOnce() {
  // In-flight guard: a slow poll must not overlap the next tick, or the two
  // could together launch more than MAX_CONCURRENT tasks.
  if (isStopping() || runningPoll) return
  runningPoll = true
  try {
    await pollOnceInner()
  } finally {
    runningPoll = false
  }
}

async function pollOnceInner() {
  if (runningTasks.size >= workerConfig.maxConcurrent) return

  const available = workerConfig.maxConcurrent - runningTasks.size

  // Candidate pending tasks. Two gates beyond status='pending':
  //  1. feature.planApprovedAt must be set — no feature-scoped task runs until
  //     its feature plan is approved by a human (the plan-approval gate).
  //     Tasks with no feature (ad-hoc/system tasks) are exempt.
  //  2. all task.dependsOn IDs must be 'done' — checked in-memory below because
  //     Postgres can't relationally filter "every element of this scalar array
  //     is in a done-set".
  // Ordered by wave so earlier waves drain before later ones.
  const pending = await prisma.task.findMany({
    where: {
      status:        'pending',
      assignedAgent: { not: null },
      AND: [
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
        {
          OR: [
            { featureId: null },
            { feature: { planApprovedAt: { not: null } } },
          ],
        },
      ],
      agent: {
        NOT: {
          metadata: { path: ['archived'], equals: true },
        },
      },
    },
    orderBy: [{ wave: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, dependsOn: true },
    take: POLL_CANDIDATE_LIMIT,
  })

  if (pending.length === 0) return

  // Build the set of completed task IDs referenced by any candidate's deps.
  const depIds = [...new Set(pending.flatMap(t => t.dependsOn))]
  const completedTaskIds = new Set<string>()
  if (depIds.length > 0) {
    const doneDeps = await prisma.task.findMany({
      where: { id: { in: depIds }, status: 'done' },
      select: { id: true },
    })
    for (const d of doneDeps) completedTaskIds.add(d.id)
  }

  let launched = 0
  for (const task of pending) {
    if (launched >= available || isStopping()) break
    // Dependency gate: every depended-upon task must be done.
    if (!task.dependsOn.every(depId => completedTaskIds.has(depId))) continue
    if (runningTasks.has(task.id)) continue
    // Atomic claim before ANY other work — only one worker can win the
    // pending → in_progress transition, so a task never runs twice.
    if (!(await claimTask(task.id))) continue
    runTask(task.id).catch(e => err(`Unhandled error in runTask(${task.id}): ${e}`))
    launched++
  }
}
