/**
 * Executor approval tools (human-only): approve / deny escalated executions.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { findExecutionForReview, assertCanReview, ExecutionReviewError } from '@/lib/execution-review'
import { parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

// ── Execution: Tool Execution Approval Gating ─────────────────────────────────

const ReviewExecutionFromToolArgs = z.object({
  executionId: z.string().nullish(),
  reason: z.string().nullish(),
})

/**
 * SOC2 [H1]: approve/deny are human-only. Agents (MCP, task runners, room agents)
 * must never be able to approve an escalated command — including their own — so the
 * handler refuses any call carrying agent/task context and requires a human admin
 * user who is not the execution's actor (assertCanReview). The decision is then sent
 * to the executor's review endpoint with that user as reviewerId; ORION re-validates
 * the reviewer when the executor writes the decision back (PATCH /api/executions/[id]).
 */
async function reviewExecutionFromTool(
  args: unknown,
  ctx: ToolExecutionContext,
  decision: 'approved' | 'denied',
): Promise<string> {
  const { executionId, reason } = parseToolArgs(ReviewExecutionFromToolArgs, args)
  if (!executionId) return 'Error: executionId is required'
  if (!reason) return 'Error: reason is required'

  if (ctx.agentId || ctx.taskId || !ctx.userId) {
    return 'Error: execution review is human-only — an admin must approve or deny this execution from the ORION UI or API.'
  }

  const reviewer = await ctx.prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { id: true, role: true, active: true },
  })
  if (!reviewer) return 'Error: reviewer not found'

  let execution
  try {
    execution = await findExecutionForReview(executionId)
    assertCanReview(execution, reviewer)
  } catch (e) {
    if (e instanceof ExecutionReviewError) return `Error: ${e.message}`
    throw e
  }

  const executorUrl = process.env.ORION_EXECUTOR_URL || 'http://orion-executor:3200'
  const executorToken = process.env.ORION_EXECUTOR_TOKEN
  if (!executorToken) return 'Error: executor service token not configured'

  const response = await fetch(`${executorUrl}/executions/${encodeURIComponent(execution.id)}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-executor-token': executorToken,
    },
    body: JSON.stringify({ decision, reason, reviewerId: reviewer.id }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    return `Error: executor service returned ${response.status}`
  }

  return `Execution ${execution.executionId} ${decision}. Reason: ${reason}`
}

export const approveExecutionTool: ToolDefinition = {
  name: 'approve_execution',
  description: 'Approve a pending tool execution that is waiting for review. Human admins only — agents cannot approve executions. The execution will proceed immediately after approval.',
  inputSchema: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The ORION execution id (from the notification in system.room.execution)',
      },
      reason: {
        type: 'string',
        description: 'Why this execution is approved (logged to audit trail)',
      },
    },
    required: ['executionId', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'execution',
  handler: (args, ctx) => reviewExecutionFromTool(args, ctx, 'approved'),
}

export const denyExecutionTool: ToolDefinition = {
  name: 'deny_execution',
  description: 'Deny a pending tool execution. Human admins only. The calling agent will receive an error. Use when the command looks suspicious, out of scope, or unsafe.',
  inputSchema: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The ORION execution id',
      },
      reason: {
        type: 'string',
        description: 'Why this execution is denied (sent back to the calling agent)',
      },
    },
    required: ['executionId', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'execution',
  handler: (args, ctx) => reviewExecutionFromTool(args, ctx, 'denied'),
}
