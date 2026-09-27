/**
 * Tool registry core: types, the registry store, lookup and argument validation.
 *
 * Tool definitions live in the sibling domain modules and are registered by
 * ./index.ts. Import from `@/lib/tool-registry` (which re-exports this module)
 * unless you are inside lib/tools/.
 */

import type { prisma } from '@/lib/db'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolTier = 'read' | 'write' | 'destructive'

export type ToolCategory =
  | 'tasks'        // task lifecycle: create, assign, close, reopen, escalate, inspect
  | 'agents'       // agent lifecycle: create, update, archive, spawn, find
  | 'rooms'        // chat rooms and messaging
  | 'features'     // feature planning and coordination
  | 'gitops'       // GitOps: propose changes, validate manifests, deployment templates
  | 'knowledge'    // knowledge base: search, write, graph
  | 'environment'  // cluster environments: health, config, bootstrap
  | 'secrets'      // secret management
  | 'execution'    // tool execution approval gating
  | 'tools'        // meta: tool discovery, tool requests, nova lookup
  | 'github'       // GitHub: repos, files, branches, pull requests
  | 'skills'       // save/list/use reusable step-by-step procedures
  | 'security'     // SOC: investigations, observables, proposed security actions

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
  tier: ToolTier
  parallelSafe: boolean  // can run concurrently with other read tools
  // 'room' = chat-room agents only (see room-tools.ts). Excluded from
  // getToolsForContext('task' | 'chat') and from MANAGEMENT_TOOL_DEFS.
  availableIn: 'task' | 'chat' | 'both' | 'room'
  category: ToolCategory
  handler: (args: unknown, context: ToolExecutionContext) => Promise<string>
}

export interface ToolExecutionContext {
  agentId?: string
  taskId?: string
  roomId?: string
  environmentId?: string
  userId?: string
  prisma: typeof prisma
  gateway?: {
    executeTool: (name: string, args: Record<string, unknown>) => Promise<string>
    listTools?: () => Promise<Array<{ name: string; description: string; category?: string; inputSchema: Record<string, unknown> }>>
  }
  // Legacy: conversationId used in chat path for propose_tool
  conversationId?: string
}

// ── Registry store ────────────────────────────────────────────────────────────

const _registry = new Map<string, ToolDefinition>()

export function registerTool(def: ToolDefinition): void {
  _registry.set(def.name, def)
}

export function getToolsForContext(ctx: 'task' | 'chat'): ToolDefinition[] {
  return Array.from(_registry.values()).filter(
    t => t.availableIn === ctx || t.availableIn === 'both'
  )
}

/** Return every registered tool regardless of availableIn context. */
export function getAllTools(): ToolDefinition[] {
  return Array.from(_registry.values())
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return _registry.get(name)
}

export function getToolsByCategory(category: ToolCategory): ToolDefinition[] {
  return Array.from(_registry.values()).filter(t => t.category === category)
}

export function getAllCategories(): ToolCategory[] {
  const cats = new Set<ToolCategory>()
  for (const t of _registry.values()) cats.add(t.category)
  return Array.from(cats).sort()
}

export async function executeRegisteredTool(
  name: string,
  args: unknown,
  context: ToolExecutionContext,
): Promise<string> {
  const def = _registry.get(name)
  if (!def) throw new Error(`Unknown tool: "${name}" — execution denied`)
  try {
    return await def.handler(args, context)
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateToolArgs(
  toolName: string,
  args: unknown,
): { valid: boolean; errors: string[] } {
  const def = _registry.get(toolName)
  if (!def) return { valid: false, errors: [`Unknown tool: "${toolName}"`] }

  const schema = def.inputSchema as {
    required?: string[]
    properties?: Record<string, { type?: string }>
  }

  const errors: string[] = []
  const obj = (typeof args === 'object' && args !== null && !Array.isArray(args))
    ? (args as Record<string, unknown>)
    : {}

  // Check required fields
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in obj) || obj[field] === undefined || obj[field] === null || obj[field] === '') {
        errors.push(`field "${field}" is required`)
      }
    }
  }

  // Check field types for fields that are present
  if (schema.properties) {
    for (const [field, prop] of Object.entries(schema.properties)) {
      if (!(field in obj)) continue
      const val = obj[field]
      if (prop.type && val !== undefined && val !== null) {
        const actual = Array.isArray(val) ? 'array' : typeof val
        if (actual !== prop.type) {
          errors.push(`field "${field}" must be ${prop.type} (got ${actual})`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
