/**
 * Shared management tool definitions and dispatcher.
 *
 * Tool definitions and handlers now live in tool-registry.ts.
 * This file re-exports everything for backwards compatibility with existing callers.
 *
 * SOC2 [A-001]: every write is attributed to the caller via actorId and logged to
 * the agent-feed audit trail (enforced in tool-registry.ts handlers).
 */

import type { ManagementToolDef } from '@/lib/agent-runner/types'
import { prisma } from '@/lib/db'
import {
  getAllTools,
  executeRegisteredTool,
  RESERVED_AGENT_NAMES,
  type ToolExecutionContext,
} from '@/lib/tool-registry'

// Ensure all tools are registered by importing the registry side-effects
import '@/lib/tool-registry'

// SOC2 [INPUT-001]: mirrors the reserved-name check in POST /api/agents
export { RESERVED_AGENT_NAMES }

// ── Backwards-compatible exports ─────────────────────────────────────────────

/**
 * MANAGEMENT_TOOL_DEFS — full list of management tool definitions in
 * ManagementToolDef shape (name + description + inputSchema only).
 * Used by openai-runner.ts, ollama-runner.ts, and watcher to build tool lists.
 */
export const MANAGEMENT_TOOL_DEFS: ManagementToolDef[] = getAllTools().map(t => ({
  name:        t.name,
  description: t.description,
  inputSchema: t.inputSchema as ManagementToolDef['inputSchema'],
}))

/**
 * executeManagedTool — execute a management tool by name.
 *
 * @param name     - Tool name (must match a registered tool)
 * @param argsRaw  - JSON-encoded arguments string
 * @param actorId  - Optional agent ID for SOC2 audit attribution
 */
export async function executeManagedTool(name: string, argsRaw: string, actorId?: string): Promise<string> {
  let args: unknown
  try { args = JSON.parse(argsRaw || '{}') } catch { args = {} }

  const ctx: ToolExecutionContext = {
    agentId: actorId,
    prisma,
  }

  return executeRegisteredTool(name, args, ctx)
}
