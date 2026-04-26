/**
 * Input validation utilities for SOC2 [input validation] compliance.
 *
 * Uses Zod for runtime schema validation. All API route inputs should
 * pass through these validators before being used in database operations.
 */

import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Parse and validate request body against a Zod schema.
 * Returns either { data: T } or { error: NextResponse }.
 *
 * Usage:
 *   const result = await parseBodyOrError(req, MySchema)
 *   if ('error' in result) return result.error
 *   const { data } = result  // type-safe T
 */
export async function parseBodyOrError<T extends z.ZodType>(
  req: NextRequest,
  schema: T,
): Promise<{ data: z.infer<T> } | { error: NextResponse }> {
  try {
    const body = await req.json()
    const data = schema.parse(body)
    return { data }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        error: NextResponse.json(
          {
            error: 'Invalid request body',
            issues: err.issues.map(i => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          { status: 400 }
        )
      }
    }
    return {
      error: NextResponse.json(
        { error: 'Bad request' },
        { status: 400 }
      )
    }
  }
}

/**
 * Legacy: Validate a JSON body against a Zod schema.
 * Returns null if invalid (caller must return 400).
 * Use parseBodyOrError() in new code instead.
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

export const UpdateNoteSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(50000).optional(),
  folder: z.string().max(100).optional(),
  pinned: z.boolean().optional(),
  type: z.enum(['note', 'wiki', 'runbook', 'llm-context']).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
})

// ── Auth Schemas ────────────────────────────────────────────────────────────────

export const TOTPVerifySchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits').regex(/^\d+$/, 'Code must be numeric'),
})

export const TOTPDisableSchema = z.object({
  password: z.string().min(1, 'Password required'),
})

export const TOTPRecoverySchema = z.object({
  code: z.string().min(1, 'Recovery code required'),
})

export const MfaVerifySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  code: z.string().min(1),
  isRecovery: z.boolean().optional(),
})

export const TOTPLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  code: z.string().min(1).optional(),
  isRecovery: z.boolean().optional(),
})

// ── Admin User Schemas ──────────────────────────────────────────────────────────

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid username'),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(200).optional(),
  role: z.enum(['admin', 'user', 'readonly']).default('user'),
})

export const UpdateUserSchema = z.object({
  username: z.string().min(3).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  name: z.string().max(200).optional(),
  role: z.enum(['admin', 'user', 'readonly']).optional(),
  active: z.boolean().optional(),
})

export const UpdateSettingsSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(10000),
})

export const UpdateSystemPromptSchema = z.object({
  key: z.string().min(1),
  name: z.string().max(200),
  content: z.string().max(50000),
})

// ── Agent Schemas ──────────────────────────────────────────────────────────────

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['claude', 'ollama', 'human', 'custom']),
  role: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(['claude', 'ollama', 'human', 'custom']).optional(),
  role: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ── Task Schemas ──────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  featureId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  assignedUserId: z.string().optional(),
})

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
  assignedAgentId: z.string().optional(),
  assignedUserId: z.string().optional(),
})

// ── Feature & Epic Schemas ─────────────────────────────────────────────────────

export const CreateFeatureSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
  epicId: z.string().optional(),
})

export const UpdateFeatureSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional(),
  epicId: z.string().optional(),
})

export const CreateEpicSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
})

export const UpdateEpicSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional(),
})

// ── Tool Approval Schemas ──────────────────────────────────────────────────────

export const CreateToolApprovalSchema = z.object({
  toolName: z.string().min(1),
  toolArgs: z.record(z.unknown()).optional(),
  reason: z.string().max(500).optional(),
})

export const UpdateConversationSchema = z.object({
  title: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ── Setup / Admin Schemas ──────────────────────────────────────────────────────

export const SetupAdminSchema = z.object({
  username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Username must be alphanumeric (hyphens/underscores allowed)'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
})

export const SetupAiProviderSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(['openai', 'anthropic', 'ollama', 'openrouter', 'custom']),
  baseUrl: z.string().url().max(2000).optional(),
  apiKey: z.string().min(1).max(1000),
  modelId: z.string().max(200),
})

export const SetupGitProviderSchema = z.object({
  type: z.enum(['github', 'gitlab', 'gitea']),
  url: z.string().url().max(2000).optional(),
  token: z.string().min(1).max(1000),
  adminUser: z.string().max(100).optional(),
  adminPassword: z.string().max(500).optional(),
  org: z.string().max(100).optional(),
})

// ── Agent Schemas ──────────────────────────────────────────────────────────────

export const AgentMessageSchema = z.object({
  content: z.string().min(1).max(50000),
  channel: z.enum(['default', 'private']).default('default'),
  messageType: z.enum(['text', 'task', 'followup']).default('text'),
  agentId: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ── Environment Schemas ─────────────────────────────────────────────────────────

export const JoinEnvironmentSchema = z.object({
  joinToken: z.string().min(1).max(200),
  gatewayType: z.enum(['cluster', 'docker', 'localhost']).default('localhost'),
  machineId: z.string().max(100).optional(),
  gatewayUrl: z.string().url().max(2000).optional(),
})

// ── Chat / Nova Schemas ─────────────────────────────────────────────────────────

export const ChatroomMessageSchema = z.object({
  content: z.string().min(1).max(50000),
  senderType: z.enum(['user', 'agent']).default('user'),
  attachments: z.array(z.string().max(2000)).max(10).optional(),
})

export const CreateConversationSchema2 = z.object({
  initialContext: z.string().max(10000).optional(),
  planTarget: z.string().max(200).optional(),
  planModel: z.string().max(100).optional(),
  agentTarget: z.string().max(100).optional(),
  agentDraft: z.string().max(100).optional(),
  agentChat: z.string().max(100).optional(),
})

export const ImportNovaSchema = z.object({
  agentName: z.string().min(1).max(200),
  agentRole: z.string().max(1000).optional(),
  systemPrompt: z.string().max(50000).optional(),
})

// ── Bug Schemas ─────────────────────────────────────────────────────────────────

export const CreateBugSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).default('open'),
  area: z.string().max(100).optional(),
  reportedBy: z.string().max(200).optional(),
  assignedUserId: z.string().max(100).optional(),
})

// ── API Key Schemas ─────────────────────────────────────────────────────────────

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1).max(100)).max(20),
  expiresAt: z.string().datetime().optional(),
})

// ── Ingress Schemas ─────────────────────────────────────────────────────────────

export const CreateIngressDomainSchema = z.object({
  name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, 'Invalid domain name'),
  type: z.enum(['http', 'https', 'grpc']).default('http'),
  notes: z.string().max(2000).optional(),
})

export const CreateIngressRouteSchema = z.object({
  host: z.string().max(500),
  paths: z.array(z.string().max(1000)).min(1),
  tls: z.object({ enabled: z.boolean(), secretName: z.string().max(200).optional() }).optional(),
  middlewares: z.array(z.string().max(200)).max(10).optional(),
  comment: z.string().max(500).optional(),
})

// ── Generic Helpers ───────────────────────────────────────────────────────────

/**
 * Truncate a string to a maximum length (SOC2: prevent oversized inputs).
 */
export function truncate(str: string | undefined | null, maxLen: number): string | null | undefined {
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

// ─── NEW SCHEMAS FOR #184 BATCH 1 ────────────────────────────────────────

// SSO Configuration (moved from inline in admin/sso/route.ts)
export const CreateSSOSchema = z.object({
  name: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  headerMode: z.boolean().optional(),
  issuerUrl: z.string().max(2000).optional(),
  groupMapping: z.record(z.string().max(200)).refine(
    (val) => Object.keys(val).length <= 20,
    { message: 'Maximum 20 group mappings allowed' }
  ).optional(),
})

// Agent Types enum (extracted from spawn/route.ts VALID_TYPES)
export const AGENT_TYPES = ['claude', 'ollama', 'human', 'custom'] as const
export const AgentTypeEnum = z.enum(AGENT_TYPES)

// Agent Spawn (corrected enum without type casting)
export const AgentSpawnSchema = z.object({
  name: z.string().min(1).max(200),
  type: AgentTypeEnum.default('claude'),
  role: z.string().max(200).nullable().optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  startConversation: z.boolean().optional(),
})
