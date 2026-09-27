import { prisma } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { recordTokenUsage } from '@/lib/token-budget'
import { log, err } from '../log'
import { logTaskEvent, postToFeed, postToRoom, writeTaskOutcome } from '../db-helpers'
import { parsePlan } from '../plan'
import { runReviewerCheck } from '../reviewer'
import type { PreparedTask, RunAccounting, RunResult } from './types'

/**
 * Plan-before-execute: a high/critical-risk (or unparseable) plan paused for
 * approval. Persist risk + plan text into metadata so the approval UI can
 * surface them and /api/tasks/:id/resume-plan can restore the approved plan.
 */
export async function pauseForPlanApproval(p: PreparedTask, run: RunResult, acc: RunAccounting): Promise<void> {
  const { taskId, task, agent, taskMeta, modelId } = p
  const { outputText, featureRoomId } = run
  const plan = parsePlan(outputText)
  const risk = plan?.riskLevel ?? 'high'
  const planText = plan?.raw ?? outputText.slice(0, 4000)
  const pauseMsg =
    `⏸️ **Plan paused for approval** (risk: ${risk})\n\n` +
    `Task **${task.title}** produced a ${risk}-risk plan and is awaiting human approval before any tools run.\n\n` +
    (plan?.summary ? `Summary: ${plan.summary}\n` : '') +
    (plan?.rollbackSteps?.length
      ? `Rollback steps:\n${plan.rollbackSteps.map((s) => `  - ${s}`).join('\n')}\n`
      : plan?.rollbackStrategy ? `Rollback: ${plan.rollbackStrategy}\n` : '')
  await Promise.all([
    prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'pending_validation',
        metadata: {
          ...taskMeta,
          planRisk: risk,
          planContent: planText,
          planSteps: plan?.steps ?? [],
          planApproved: false,
          pendingReason: 'plan_approval',
        } as object,
      },
    }),
    logTaskEvent(taskId, 'plan_pending_approval',
      `Risk=${risk}. ${plan?.summary ?? ''}\n\n${planText}`, agent.id),
    postToFeed(agent.id, pauseMsg, taskId),
    ...(featureRoomId ? [postToRoom(featureRoomId, agent.id, pauseMsg, taskId)] : []),
  ])
  notify({ type: 'plan_approval_needed', taskId, taskTitle: task.title, agentId: agent.id, agentName: agent.name, riskLevel: risk }).catch(() => {})
  // BUG 4 fix: tokens may already have been spent generating the plan
  // itself before pausing for approval — record them so budget accounting
  // isn't silently dropped on this return path.
  if (acc.totalInputTokens > 0 || acc.totalOutputTokens > 0) {
    await recordTokenUsage(agent.id, taskId, acc.totalInputTokens, acc.totalOutputTokens, modelId).catch(
      (e) => err(`[worker] recordTokenUsage (plan-pause) failed for task ${taskId}: ${e instanceof Error ? e.message : e}`)
    )
  }
  log(`Task "${task.title}" (${taskId}) paused for ${risk}-risk plan approval`)
}

/**
 * Successful run: move the task to QA review, announce completion, record
 * usage, run the optional reviewer and — unless it rejected the output —
 * publish the outcome note and drop the checkpoints. Closes the trace.
 */
export async function finalizeSuccess(p: PreparedTask, run: RunResult, acc: RunAccounting, startedAt: number): Promise<void> {
  const { taskId, task, agent, taskMeta, modelId, agentGw } = p
  const { outputText, toolsUsed, conversationId, featureRoomId } = run
  const { totalInputTokens, totalOutputTokens } = acc
  const metadata = (task.metadata ?? {}) as Record<string, unknown>

  const durationSec = Math.round((Date.now() - startedAt) / 1000)
  const summary = outputText.slice(-500) || 'Task completed.'

  const completionMsg = `✅ Completed: **${task.title}** (${durationSec}s · ${toolsUsed.length} tools)\n\n${summary}`

  // Delegation result propagation
  const delegation = metadata.delegation as { roomId?: string; ringLeaderId?: string } | undefined
  const roomPromises = featureRoomId ? [postToRoom(featureRoomId, agent.id, completionMsg, taskId)] : []
  if (delegation?.roomId) {
    const delegateResult = `🔔 **Delegation complete**: ${task.title}\n\n${summary}`
    roomPromises.push(postToRoom(delegation.roomId, agent.id, delegateResult, taskId))
  }

  await Promise.all([
    prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'pending_validation',
        metadata: { ...taskMeta, pendingReason: 'qa_review' } as object,
      },
    }),
    logTaskEvent(taskId, 'completed', summary, agent.id),
    // SOC2: always keep postToFeed for audit trail
    postToFeed(agent.id, completionMsg, taskId),
    // Post to feature room and any delegation room
    ...roomPromises,
    prisma.claudeInvocation.create({
      data: {
        conversationId,
        prompt:     task.title,
        toolsUsed,
        tokensUsed: totalInputTokens + totalOutputTokens || null,
        durationMs: Date.now() - startedAt,
        success:    true,
      },
    }).catch(e => err(`[worker] claudeInvocation write failed for task ${taskId}: ${e instanceof Error ? e.message : e}`)),
  ])

  notify({ type: 'task_completed', taskId, taskTitle: task.title, agentId: agent.id, agentName: agent.name }).catch(() => {})

  // Log token usage to the task timeline when available.
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    await logTaskEvent(
      taskId,
      'usage',
      `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out (total: ${totalInputTokens + totalOutputTokens})`,
      agent.id,
    ).catch(() => {})
    // Record token spend for budget tracking
    await recordTokenUsage(agent.id, taskId, totalInputTokens, totalOutputTokens, modelId).catch(
      (e) => err(`[worker] recordTokenUsage failed for task ${taskId}: ${e instanceof Error ? e.message : e}`)
    )
  }

  // Run reviewer check BEFORE writing the outcome note / deleting checkpoints.
  // If the reviewer rejects, it reopens the task (status back to 'pending', or
  // 'failed' once retries are exhausted) — in that case we must NOT publish a
  // "done" outcome note to the knowledge base (future agents would treat it as
  // fact) and must NOT delete checkpoints (the reopened run needs them to avoid
  // re-executing already-completed side-effectful tool calls from scratch).
  let reviewerRejected = false
  if (metadata.persistent !== true) {
    reviewerRejected = await runReviewerCheck(taskId, task.title, outputText, agent.id, modelId)
  }

  if (!reviewerRejected) {
    // Auto-write the task outcome to the knowledge base so future agents learn
    // from it via vector-search context injection.
    const envName = agentGw?.environmentId
      ? (await prisma.environment.findUnique({ where: { id: agentGw.environmentId }, select: { name: true } }).catch(() => null))?.name ?? null
      : null
    await writeTaskOutcome({
      title:           task.title,
      description:     task.description,
      status:         'done',
      outcomeSummary: `Completed in ${durationSec}s using ${toolsUsed.length} tool call(s)${toolsUsed.length ? ` (${[...new Set(toolsUsed)].slice(0, 8).join(', ')})` : ''}. ${summary}`.trim(),
      environmentId:   agentGw?.environmentId ?? null,
      environmentName: envName,
    })

    // Clean up checkpoints on successful completion — no longer needed.
    await prisma.taskCheckpoint.deleteMany({ where: { taskId } }).catch(() => {})
  }

  // Langfuse: close the main span and flush the trace
  const trace = acc.trace
  if (trace) {
    trace.recordGeneration({ model: modelId, input: task.title, output: outputText.slice(0, 1000), inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
    if (acc.mainSpan) trace.endSpan(acc.mainSpan, { summary: outputText.slice(0, 500) })
    trace.complete(outputText.slice(0, 500))
    await trace.flush()
  }

  log(`Completed task "${task.title}" (${taskId}) in ${durationSec}s`)
}
