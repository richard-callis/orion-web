/**
 * Correlation ID Utility
 *
 * Generates unique request correlation IDs for error tracking and debugging.
 * Used in both request/response cycles and error logs.
 *
 * SOC2 [H-002]: Error handling without information disclosure
 */

/**
 * Generate a unique correlation ID for a request.
 * Returns a short format suitable for including in error responses.
 * Uses globalThis.crypto (Web Crypto API) so it works in both Node.js and edge runtime.
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID().split('-')[0]
}

/**
 * Extract correlation ID from request headers or generate new one.
 * Follows X-Correlation-ID convention.
 */
export function getOrCreateCorrelationId(headers?: Record<string, string | string[]>): string {
  if (!headers) return generateCorrelationId()

  const existing = headers['x-correlation-id']
  if (typeof existing === 'string' && existing.length > 0) {
    return existing
  }

  if (Array.isArray(existing) && existing.length > 0 && typeof existing[0] === 'string') {
    return existing[0]
  }

  return generateCorrelationId()
}

/**
 * Format error response with correlation ID.
 * Clients see this to reference errors in support tickets.
 */
export function formatErrorResponse(message: string, correlationId: string) {
  return {
    error: message,
    correlationId,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Format error log entry with full context.
 * Includes original error details for internal debugging.
 */
export function formatErrorLog(
  correlationId: string,
  message: string,
  error: unknown,
  context?: Record<string, unknown>
) {
  return {
    correlationId,
    message,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : String(error),
    context,
  }
}
