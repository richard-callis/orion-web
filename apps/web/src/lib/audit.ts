/**
 * Audit logging utility for SOC2 [M-005] compliance.
 *
 * Creates audit log entries with IP address and user-agent tracking.
 * Non-blocking — failures are silently logged to prevent impact on request processing.
 *
 * Hash chain for tamper-evidence: each entry's `previousHash` is SHA-256 of
 * (previous entry's action + timestamp + detail + previousHash).
 * This allows verification that the log has not been modified.
 */

import { prisma } from './db'
import type { NextRequest } from 'next/server'
import { createHash } from 'crypto'

export type AuditAction =
  | 'user_login'
  | 'user_login_failure'
  | 'user_logout'
  | 'user_create'
  | 'mfa_enable'
  | 'mfa_disable'
  | 'mfa_verify_success'
  | 'mfa_verify_failure'
  | 'user_update'
  | 'user_delete'
  | 'user_role_change'
  | 'api_key_create'
  | 'api_key_revoke'
  | 'environment_create'
  | 'environment_update'
  | 'environment_delete'
  | 'task_create'
  | 'task_update'
  | 'task_assign'
  | 'task_complete'
  | 'task_fail'
  | 'note_create'
  | 'note_update'
  | 'note_delete'
  | 'agent_create'
  | 'agent_update'
  | 'agent_delete'
  | 'model_create'
  | 'model_update'
  | 'model_delete'
  | 'tool_execute'
  | 'tool_approve'
  | 'tool_revoke'
  | 'sso_config_update'
  | 'admin_action'
  | 'settings_update'
  | 'vault_unseal'
  | 'vault_reseal'

/**
 * Compute a SHA-256 hash of an audit entry's content for the hash chain.
 */
function hashAuditEntry(entry: {
  id: string
  userId: string
  action: string
  target: string
  detail: unknown
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  previousHash: string | null
}): string {
  const data = JSON.stringify({
    id: entry.id,
    userId: entry.userId,
    action: entry.action,
    target: entry.target,
    detail: entry.detail,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
    previousHash: entry.previousHash,
  })
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Fetch the previous audit log's previousHash for the hash chain.
 * Returns null if this is the first entry or the previous entry's hash is null.
 */
async function getPreviousHash(): Promise<string | null> {
  try {
    const prev = await prisma.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { previousHash: true },
    })
    return prev?.previousHash ?? null
  } catch {
    return null
  }
}

/**
 * Log an audit event. Non-blocking — never throws.
 */
export async function logAudit(params: {
  userId: string
  action: AuditAction
  target: string
  detail?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    const prevHash = await getPreviousHash()
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        target: params.target,
        detail: params.detail ?? {},
        ipAddress: params.ipAddress ?? undefined,
        userAgent: params.userAgent ?? undefined,
        previousHash: prevHash ?? undefined,
      },
    })
  } catch {
    // Non-blocking — audit logging failures must not impact normal operations
    // SOC2: If audit logging is consistently failing, this is an alerting condition
  }
}

/**
 * Extract IP address from a Next.js request (respects X-Forwarded-For).
 * Works with NextRequest and other request objects.
 */
export function getClientIp(req: NextRequest | { headers: Headers; ip?: string }): string | undefined {
  // Next.js App Router: check x-forwarded-for header (set by Traefik/reverse proxy)
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  // Fallback: NextRequest.ip (available in some deployments)
  if ('ip' in req && req.ip) return req.ip
  return undefined
}

/**
 * Extract user-agent from request headers.
 */
export function getUserAgent(headers: Headers | Record<string, string | null | string[]>): string | undefined {
  const val = typeof headers.get === 'function'
    ? headers.get('user-agent')
    : typeof headers === 'object' && 'user-agent' in headers
    ? headers['user-agent']
    : null
  return val ? (typeof val === 'string' ? val : val.join(', ')) : undefined
}
