import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { createRunner } from '@/lib/agent-runner'
import type { TaskRunContext } from '@/lib/agent-runner'
import { MANAGEMENT_TOOL_DEFS, executeManagedTool } from '@/lib/management-tools'
import { createTrace } from '@/lib/langfuse'
import { redactSecrets } from '@/lib/redact'
import { err } from '../log'
import { findOrCreateFeatureRoom, logTaskEvent, postToFeed, postToRoom } from '../db-helpers'
import { parsePlan, planRequiresApproval } from '../plan'
import type { PreparedTask, RunAccounting, RunResult } from './types'

/**
 * Run the agent: create the task conversation, announce the start, then
 * consume the runner's events — persisting messages, tool calls/results,
 * checkpoints and token usage — until it finishes or pauses for plan approval.
 * Throws on runner errors or when `signal` fires (task timeout).
 */
export async function executeRun(p: PreparedTask, acc: RunAccounting, signal: AbortSignal): Promise<RunResult> {
  const { taskId, task, agent, modelId, systemPrompt, planBeforeExecute, agentGw, gateway } = p

  // Create a conversation to hold the task's AI activity
  const conversation = await prisma.conversation.create({
    data: {
      title: `Task: ${task.title}`,
      metadata: { taskId, agentId: agent.id, orchestrated: true },
    },
  })

  // Find or create the feature coordination room (if task has a featureId)
  const featureId = task.feature?.id ?? null
  const featureRoomId: string | null = featureId
    ? await findOrCreateFeatureRoom(featureId, agent.id)
    : null

  // Log start event
  await logTaskEvent(taskId, 'started', `Agent "${agent.name}" [${modelId}] starting task`, agent.id)
  // SOC2: always keep postToFeed as the audit trail
  await postToFeed(agent.id, `▶ Starting task: **${task.title}**`, taskId)
  // Additionally post to feature room if one exists
  if (featureRoomId) {
    await postToRoom(featureRoomId, agent.id, `▶ Starting task: **${task.title}**`, taskId)
  }

  const roomNote = featureRoomId
    ? `\n\n[Chat room for this task: ${featureRoomId} — use this room_id when calling orion_send_message]`
    : ''

  const ctx: TaskRunContext = {
    taskId,
    taskTitle:       task.title,
    taskDescription: (task.description ?? '') + roomNote,
    taskPlan:        task.plan ?? null,
    agentId:         agent.id,
    agentName:       agent.name,
    systemPrompt,
    modelId,
    gateway,
    environmentId:   agentGw?.environmentId,
    managementTools: {
      definitions: MANAGEMENT_TOOL_DEFS,
      execute: (name, argsRaw) => executeManagedTool(name, argsRaw, agent.id),
    },
    signal,
  }

  const runner = createRunner(modelId)
  let outputText = ''
  const toolsUsed: string[] = []

  // Langfuse: create a trace for this task run (no-op when keys are not set)
  const trace = createTrace({ taskId, taskTitle: task.title, agentId: agent.id, modelId })
  acc.trace = trace
  acc.mainSpan = trace.startSpan('task-execution', { title: task.title, description: task.description })
  // FIFO queue of open tool span IDs — tool_call pushes, tool_result shifts
  const toolSpanQueue: string[] = []
  // BUG 7 fix: FIFO queue of idempotency keys computed at tool_call time
  // (stepIndex BEFORE increment, real args). tool_result reuses the same key
  // as the checkpoint's argsHash instead of recomputing with a different
  // (post-increment, empty-args) input — the two computations could never
  // match before, so replay matched checkpoints by ordinal position alone
  // instead of verifying the same tool+args were called on retry.
  const idemKeyQueue: string[] = []

  let pausedForApproval = false

  // Step-level checkpointing: load any existing checkpoints so we can record
  // each completed tool_result step and replay them on retry.
  const checkpoints = new Map<number, { toolName: string; result: string }>()
  const existingCheckpoints = await prisma.taskCheckpoint.findMany({
    where: { taskId },
    select: { stepIndex: true, toolName: true, result: true },
  }).catch(() => [])
  for (const c of existingCheckpoints) checkpoints.set(c.stepIndex, { toolName: c.toolName, result: c.result })
  let stepIndex = 0

  // Inject checkpoints into ctx so runners can replay without re-executing tools
  ctx.checkpoints = checkpoints.size > 0 ? checkpoints : undefined

  // Plan gate for runners that execute tools internally. The claude:* sidecar
  // runs the whole tool loop over MCP and only reports text/usage, so the
  // tool_call interception below never fires for it. Instead run a separate
  // plan-only turn (no tools) and gate on that plan before execution starts.
  // No parseable plan fails closed: it is paused for human review.
  const runnerExecutesToolsInternally = modelId === 'claude' || modelId.startsWith('claude:')
  if (planBeforeExecute && runnerExecutesToolsInternally) {
    for await (const event of runner.run({ ...ctx, planOnly: true })) {
      if (event.type === 'text') outputText += event.content
      else if (event.type === 'usage') {
        acc.totalInputTokens  += event.inputTokens
        acc.totalOutputTokens += event.outputTokens
      } else if (event.type === 'error') throw new Error(event.error)
    }
    if (outputText) {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: 'assistant', content: outputText },
      }).catch(e => err(`[worker] plan message write failed: ${e instanceof Error ? e.message : e}`))
    }
    const plan = parsePlan(outputText)
    if (!plan || planRequiresApproval(plan)) {
      pausedForApproval = true
    } else {
      await logTaskEvent(taskId, 'plan_auto_approved', `Risk=${plan.riskLevel ?? 'unknown'} — proceeding without human approval.\n\n${plan.raw}`, agent.id)
      ctx.taskPlan = ctx.taskPlan ? `${ctx.taskPlan}\n\n${plan.raw}` : plan.raw
    }
  }

  if (!pausedForApproval) for await (const event of runner.run(ctx)) {
    // Check for task-level abort (60-minute timeout)
    if (signal.aborted) {
      throw new Error('Task exceeded maximum runtime of 60 minutes and was automatically terminated.')
    }

    switch (event.type) {
      case 'text':
        outputText += event.content
        // Store message in conversation
        await prisma.message.create({
          data: { conversationId: conversation.id, role: 'assistant', content: event.content },
        }).catch(e => err(`[worker] conversation message write failed: ${e instanceof Error ? e.message : e}`))
        break

      case 'tool_call': {
        // Plan gate: a high/critical-risk plan must be approved before tools run.
        if (planBeforeExecute) {
          const plan = parsePlan(outputText)
          if (planRequiresApproval(plan)) {
            pausedForApproval = true
            break
          }
        }
        toolsUsed.push(event.tool)
        // Compute deterministic idempotency key for this tool call to prevent
        // duplicate side effects on retry.
        const idemKey = createHash('sha256')
          .update(`${taskId}:${stepIndex}:${event.tool}:${event.args ?? ''}`)
          .digest('hex')
          .slice(0, 16)
        idemKeyQueue.push(idemKey)
        // Langfuse: start a span for this tool call
        toolSpanQueue.push(trace.startSpan(`tool:${event.tool}`, { args: event.args }))
        await logTaskEvent(taskId, 'tool_call', `🔧 ${event.tool}(${event.args}) [idem:${idemKey}]`, agent.id)
        await prisma.message.create({
          data: {
            conversationId: conversation.id, role: 'assistant',
            content: `[tool_call] ${event.tool}`,
            metadata: { toolCall: { name: event.tool, args: event.args } },
          },
        }).catch(e => err(`[worker] tool_call message write failed: ${e instanceof Error ? e.message : e}`))
        if (featureRoomId) {
          const argsSummary = String(event.args ?? '').slice(0, 200)
          await postToRoom(featureRoomId, agent.id, `🔧 \`${event.tool}\`(${argsSummary})`, taskId)
        }
        break
      }

      case 'tool_result': {
        // MAJOR fix: redactSecrets was applied only to the room-feed copy; the
        // logTaskEvent and Message writes stored raw tool results including any
        // secrets/credentials returned by shell/kubectl/vault tools. Apply
        // redaction consistently before any write.
        const redactedResult = redactSecrets(event.result).slice(0, 2000)
        // Langfuse: end the oldest open tool span (FIFO)
        const openToolSpanId = toolSpanQueue.shift()
        if (openToolSpanId) trace.endSpan(openToolSpanId, { result: redactedResult.slice(0, 500) })
        await logTaskEvent(taskId, 'tool_result', redactedResult, agent.id)
        // Checkpoint this step so it can be detected on retry.
        // BUG 7 fix: reuse the SAME idempotency key computed at tool_call time
        // (same stepIndex, same args) instead of recomputing with the
        // post-increment stepIndex and an always-empty args string — those two
        // computations could never match, so retries replayed checkpoints
        // purely by ordinal position rather than verifying tool+args.
        const idemKeyForCheckpoint = idemKeyQueue.shift() ?? createHash('sha256')
          .update(`${taskId}:${stepIndex}:${event.tool}:`)
          .digest('hex')
          .slice(0, 16)
        stepIndex++
        await prisma.taskCheckpoint.upsert({
          where: { taskId_stepIndex: { taskId, stepIndex } },
          update: { result: redactedResult },
          create: { taskId, stepIndex, toolName: event.tool, argsHash: idemKeyForCheckpoint, result: redactedResult },
        }).catch(e => err(`[worker] checkpoint upsert failed for task ${taskId} step ${stepIndex}: ${e instanceof Error ? e.message : e}`))
        checkpoints.set(stepIndex, { toolName: event.tool, result: redactedResult })
        await prisma.message.create({
          data: {
            conversationId: conversation.id, role: 'user',
            content: `[tool_result] ${event.tool}: ${redactedResult}`,
          },
        }).catch(e => err(`[worker] tool_result message write failed: ${e instanceof Error ? e.message : e}`))
        if (featureRoomId) {
          const safeResult = redactedResult.slice(0, 300)
          await postToRoom(featureRoomId, agent.id, `↩ \`${event.tool}\`: ${safeResult}`, taskId)
        }
        break
      }

      case 'usage':
        acc.totalInputTokens  += event.inputTokens
        acc.totalOutputTokens += event.outputTokens
        break

      case 'done':
        break

      case 'error':
        throw new Error(event.error)
    }

    // Stop consuming the runner once we've paused for plan approval — no
    // further tools should execute until a human approves the plan.
    if (pausedForApproval) break
  }

  return { pausedForApproval, outputText, toolsUsed, conversationId: conversation.id, featureRoomId }
}
