/**
 * Input validation utilities for SOC2 [input validation] compliance.
 *
 * Uses Zod for runtime schema validation. All API route inputs should
 * pass through these validators before being used in database operations.
 */

import { z } from 'zod'

/**
 * Validate a JSON body against a Zod schema.
 * Returns a NextResponse error if invalid, null if valid.
 */
export function validateBody<T extends z.ZodType>(
  body: unknown,
  schema: T,
  options?: { errorPrefix?: string },
): z.infer<T> | null {
  try {
    const parsed = schema.parse(body)
    return parsed
  } catch (err) {
    const zodErr = err as z.ZodError
    const prefix = options?.errorPrefix ?? 'Invalid input'
    return null // caller should return 400 with error details
  }
}

// ── Conversation Schemas ──────────────────────────────────────────────────────

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  initialContext: z.string().max(10000).optional(),
  planTarget: z.string().max(200).optional(),
  planModel: z.string().max(100).optional(),
  agentTarget: z.string().max(100).optional(),
  agentDraft: z.string().max(100).optional(),
  agentChat: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ── Environment Schemas ───────────────────────────────────────────────────────

export const CreateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'name must be a valid DNS label (lowercase alphanumeric, hyphens, 1-100 chars)',
  }),
  type: z.enum(['cluster', 'docker', 'localhost']).default('cluster'),
  description: z.string().max(2000).optional(),
  gatewayUrl: z.string().url({ message: 'gatewayUrl must be a valid URL' }).nullable(),
  gatewayToken: z.string().max(1000).optional(),
  gitOwner: z.string().max(100).optional(),
  gitRepo: z.string().max(100).optional(),
  policyConfig: z.record(z.unknown()).optional(),
  kubeconfig: z.string().max(50000).optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ── Note Schemas ──────────────────────────────────────────────────────────────

export const CreateNoteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(50000).default(''),
  folder: z.string().max(100).default('General'),
  pinned: z.boolean().default(false),
  type: z.enum(['note', 'wiki', 'runbook', 'llm-context']).default('note'),
  tags: z.array(z.string().max(50)).max(10).optional(),
})

// ── Generic Helpers ───────────────────────────────────────────────────────────

/**
 * Truncate a string to a maximum length (SOC2: prevent oversized inputs).
 */
export function truncate(str: string | undefined | null, maxLen: number): string | undefined {
  if (!str) return str
  return str.length > maxLen ? str.slice(0, maxLen) : str
}

/**
 * Sanitize a title for safe use in system prompts (strip dangerous characters).
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[<>]/g, '')           // strip angle brackets
    .replace(/\u0000/g, '')         // strip null bytes
    .replace(/\r\n/g, '\n')         // normalize newlines
    .slice(0, 200)                   // enforce length
    .trim()
}
