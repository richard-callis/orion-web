/**
 * Audit logging utility for SOC2 [M-005] compliance.
 *
 * Creates audit log entries with IP address and user-agent tracking.
 * Non-blocking — failures are silently logged to prevent impact on request processing.
 */

import { prisma } from './db'
import type { NextRequest } from 'next/server'

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
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        target: params.target,
        detail: params.detail ?? {},
        ipAddress: params.ipAddress ?? undefined,
        userAgent: params.userAgent ?? undefined,
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
