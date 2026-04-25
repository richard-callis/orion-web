/**
 * Error sanitization utilities for SOC2 [CC7] — prevent information leakage.
 *
 * Strips internal details (stack traces, connection strings, file paths) from
 * error messages before forwarding them to clients.
 */

/**
 * Sanitize an error for safe display to clients.
 * - Prisma errors: return mapped user-friendly messages
 * - Network/API errors: return generic message
 * - Unknown errors: return 'An unexpected error occurred'
 */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    // Prisma known errors — map to user-friendly messages
    if (err.name === 'PrismaClientKnownRequestError') {
      return handlePrismaKnown(err)
    }
    if (err.name === 'PrismaClientUnknownRequestError') {
      return 'A database error occurred. Please try again later.'
    }
    if (err.name === 'PrismaClientInitializationError') {
      return 'The database is currently unavailable. Please try again later.'
    }
    if (err.name === 'PrismaClientRustPanicError') {
      return 'An internal error occurred. Please try again later.'
    }
    // Check for common error patterns in message/stack
    const msg = err.message
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      return 'The requested service is temporarily unavailable. Please try again later.'
    }
    if (msg.includes('ECONNRESET') || msg.includes('socket hang up')) {
      return 'The connection was reset. Please try again.'
    }
    if (msg.includes('EROFS') || msg.includes('EACCES') || msg.includes('ENOENT')) {
      return 'A system error occurred. Please try again later.'
    }
    if (msg.includes('model timed out') || msg.includes('abort')) {
      return 'The request timed out. Please try again.'
    }
    // Generic Error — strip stack traces
    return err.message.split('\n')[0].split(':')[0].trim()
  }

  if (typeof err === 'string') {
    // Check if it's a JSON string (e.g., API error body)
    try {
      const parsed = JSON.parse(err)
      if (typeof parsed?.message === 'string') {
        return sanitizeError(new Error(parsed.message))
      }
    } catch {
      // Not JSON — treat as plain string
    }
    // Strip anything that looks like a file path or stack trace
    const clean = err.replace(/(?:at\s+)?[^\n]*(?:\.ts|\.js|:\d+:\d+)/g, '').trim()
    return clean || 'An unexpected error occurred'
  }

  return 'An unexpected error occurred'
}

/**
 * Handle Prisma known request errors by extracting user-facing messages.
 */
function handlePrismaKnown(err: Error): string {
  const msg = err.message
  if (msg.includes('Unique constraint failed') || msg.includes('duplicate key')) {
    return 'A resource with this value already exists.'
  }
  if (msg.includes('Foreign key constraint failed')) {
    return 'The requested resource is referenced by other data. Remove references first.'
  }
  if (msg.includes('check constraint')) {
    return 'The provided value is invalid. Please check your input.'
  }
  if (msg.includes('null constraint')) {
    return 'Required fields are missing.'
  }
  if (msg.includes('does not exist')) {
    return 'The requested resource was not found.'
  }
  // Generic Prisma error
  return 'A database error occurred. Please try again later.'
}
