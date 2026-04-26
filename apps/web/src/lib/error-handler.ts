/**
 * Centralized Error Handler
 *
 * Sanitizes errors for client responses while preserving details for server logs.
 * Automatically includes correlation IDs for error tracking.
 *
 * SOC2 [H-002]: Error handling without information disclosure
 * Prevents leakage of: stack traces, SQL errors, file paths, internal state
 */

import { NextResponse } from 'next/server'
import { formatErrorResponse, formatErrorLog } from './correlation-id'

// Logger interface (uses your existing logger if available)
interface Logger {
  error: (msg: string, context: unknown) => void
}

let logger: Logger | null = null

export function setErrorLogger(l: Logger) {
  logger = l
}

/**
 * Handle an error and return a safe NextResponse.
 *
 * Rules:
 * - 4xx errors: Safe to include details (validation errors, not found, etc.)
 * - 5xx errors: Generic message to client, full details to server log
 * - Never leak: SQL errors, stack traces, file paths, Prisma error messages
 */
export function handleApiError(
  error: unknown,
  correlationId: string,
  statusCode: number = 500,
  context?: Record<string, unknown>
): NextResponse {
  const isClientError = statusCode >= 400 && statusCode < 500
  const isSqlError = isSqlInjectionError(error)
  const hasPrismaError = isPrismaError(error)

  // Log the full error server-side
  const logEntry = formatErrorLog(correlationId, 'API Error', error, context)
  if (logger) {
    logger.error('API Error', logEntry)
  } else {
    console.error('[ERROR]', JSON.stringify(logEntry))
  }

  // Determine message for client
  let clientMessage = 'An error occurred'

  if (isClientError && !isSqlError && !hasPrismaError) {
    // Safe to return detailed 4xx errors (validation, not found, etc.)
    if (error instanceof Error) {
      clientMessage = error.message
    }
  }
  // For 5xx errors or SQL/Prisma errors, always use generic message

  // Return sanitized response
  return NextResponse.json(
    formatErrorResponse(clientMessage, correlationId),
    { status: statusCode }
  )
}

/**
 * Detect SQL injection error patterns in error messages.
 * These should never be sent to clients.
 */
function isSqlInjectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('syntax error') ||
    msg.includes('postgresql') ||
    msg.includes('sql') ||
    msg.includes('constraint')
  )
}

/**
 * Detect Prisma ORM errors.
 * Prisma error messages include schema details that shouldn't be public.
 */
function isPrismaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes('Prisma') ||
      (error as any).code?.startsWith('P'))
  )
}

/**
 * Middleware-friendly error handler for use in route handlers.
 *
 * Usage:
 * ```
 * try {
 *   // ... operation
 * } catch (err) {
 *   return handleApiError(err, correlationId)
 * }
 * ```
 */
export async function handleUnexpectedError(
  error: unknown,
  correlationId: string
): Promise<NextResponse> {
  return handleApiError(error, correlationId, 500)
}

/**
 * Sanitize Prisma errors before returning to client.
 * Strips table names, field names, constraint details.
 */
export function sanitizePrismaError(error: unknown): string {
  if (!(error instanceof Error)) return 'Operation failed'

  const msg = error.message

  // Check for specific Prisma error patterns
  if (msg.includes('Unique constraint')) {
    return 'This record already exists'
  }
  if (msg.includes('Foreign key constraint')) {
    return 'Referenced record not found'
  }
  if (msg.includes('NOT NULL constraint')) {
    return 'Required field missing'
  }

  // Generic fallback
  return 'Operation failed'
}
