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

// Register Warden SIEM management tools (siem_get_incident, siem_create_investigation,
// siem_add_observable, siem_add_note, siem_update_incident_status, siem_add_timeline_entry).
import { registerWardenManagementTools } from '@/lib/siem/warden-management-tools'
registerWardenManagementTools()

// Register GitHub agent tools (github_list_repos, github_get_file,
// github_create_or_update_file, github_create_branch, github_create_pull_request).
import { registerGithubTools } from '@/lib/github-tools'
registerGithubTools()

import { registerSkillTools } from '@/lib/skill-tools'
registerSkillTools()

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
 * @param actorId  - Optional Agent ID for SOC2 audit attribution (background/room
 *   agents — worker.ts). This is a real `Agent.id` foreign key: several registry
 *   handlers use `ctx.agentId` to look up an `Agent` row or a `ToolAgentRestriction`
 *   (see e.g. tool-registry.ts's agent-group handlers), so it must never be a
 *   `User.id` — see `userId` below for that case.
 * @param userId   - Optional human User ID, for tool calls made in an ordinary
 *   per-user chat conversation (claude.ts's OpenAI-compatible tool loop) where
 *   there is no `Agent` acting autonomously. Previously such calls were passed
 *   through `actorId`, which silently mismapped a `User.id` onto `ctx.agentId`
 *   (wrong FK space, and left `ctx.userId` — and therefore any per-user note
 *   scoping like `knowledge_search`'s — unset).
 */
export async function executeManagedTool(name: string, argsRaw: string, actorId?: string, userId?: string): Promise<string> {
  let args: unknown
  try { args = JSON.parse(argsRaw || '{}') } catch { args = {} }

  const ctx: ToolExecutionContext = {
    agentId: actorId,
    userId,
    prisma,
  }

  return executeRegisteredTool(name, args, ctx)
}
