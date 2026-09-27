/**
 * Unified Tool Registry — single source of truth for all ORION management tools.
 *
 * Tools are classified by tier (read / write / destructive) and availability context
 * (task / chat / both / room). The registry is the canonical definition; management-tools.ts
 * and claude.ts import from here rather than duplicating definitions.
 *
 * SOC2 [A-001]: all write/destructive operations are attributed via actorId and logged
 * to the agent-feed audit trail inside the handler logic.
 *
 * Layout:
 *   lib/tools/registry.ts  — types, store, lookup, argument validation
 *   lib/tools/shared.ts    — helpers shared by tool modules (auditLog, parseArgs)
 *   lib/tools/<domain>.ts  — tool definitions (agents, tasks, rooms, gitops, …)
 *   lib/tools/index.ts     — registers the built-in tools in canonical order
 *
 * This module keeps the historical import path working: importing it loads the
 * registry and registers every built-in tool.
 */

export * from './tools/registry'
export { RESERVED_AGENT_NAMES } from './tools/shared'
export { ACCESS_ADMIN_GROUP_NAME } from './tools/access'
export { BUILTIN_TOOLS } from './tools/index'
