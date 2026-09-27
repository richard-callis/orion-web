import type { Prisma } from '@prisma/client'
import type { resolveAgentGateway } from '@/lib/agent-gateway'
import type { createTrace } from '@/lib/langfuse'

export type TaskWithAgent = Prisma.TaskGetPayload<{
  include: { agent: true; feature: { select: { id: true } } }
}>
export type TaskAgent = NonNullable<TaskWithAgent['agent']>
export type AgentGatewayInfo = Awaited<ReturnType<typeof resolveAgentGateway>>

/** Everything resolved before a task run starts (buildTaskContext). */
export interface PreparedTask {
  taskId: string
  task: TaskWithAgent
  agent: TaskAgent
  /** task.metadata snapshot taken when the task was loaded. */
  taskMeta: Record<string, unknown>
  modelId: string
  systemPrompt: string
  /** The agent must emit a plan that is gated before tools run. */
  planBeforeExecute: boolean
  agentGw: AgentGatewayInfo
  gateway: { url: string; token: string } | null
}

/**
 * Mutable per-run accounting shared across the phases so every exit path
 * (success, plan pause, federation, failure) can record spent tokens, release
 * the budget reservation and close the trace.
 */
export interface RunAccounting {
  totalInputTokens: number
  totalOutputTokens: number
  /** Set once the agent is known; used to release the budget reservation. */
  agentId: string | null
  budgetReservationTokens: number
  trace: ReturnType<typeof createTrace> | null
  mainSpan: string | null
}

/** Result of consuming the runner (executeRun). */
export interface RunResult {
  pausedForApproval: boolean
  outputText: string
  toolsUsed: string[]
  conversationId: string
  featureRoomId: string | null
}
