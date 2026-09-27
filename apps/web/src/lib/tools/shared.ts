/**
 * Helpers shared by the tool domain modules.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'

// ── Shared helpers ────────────────────────────────────────────────────────────

// SOC2 [INPUT-001]: mirrors the reserved-name check in POST /api/agents
export const RESERVED_AGENT_NAMES = ['human', 'user', 'system', 'admin']

export async function auditLog(actorId: string | undefined, content: string): Promise<void> {
  if (!actorId) return
  await prisma.agentMessage.create({
    data: {
      agentId:     actorId,
      channel:     'agent-feed',
      content,
      messageType: 'task_update',
    },
  }).catch(e => console.error('[tool-registry] auditLog write failed:', e instanceof Error ? e.message : e))
}

/** Normalise raw tool args (object or JSON string) to a plain object. */
export function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) return args as Record<string, unknown>
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args || '{}')
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }
  return {}
}

/**
 * Parse tool args against a per-tool zod schema. Schemas mirror the tool's
 * JSON inputSchema types; optional fields are `.nullish()` because models
 * often send `null` for omitted fields. Handlers keep their own "X is
 * required" checks so user-facing error messages are unchanged. A type
 * mismatch throws, which executeRegisteredTool reports as `Error: …`.
 */
export function parseToolArgs<S extends z.ZodTypeAny>(schema: S, args: unknown): z.infer<S> {
  const result = schema.safeParse(parseArgs(args))
  if (!result.success) {
    const detail = result.error.issues.map(e => `${e.path.join('.') || 'args'}: ${e.message}`).join('; ')
    throw new Error(`invalid arguments — ${detail}`)
  }
  return result.data
}
