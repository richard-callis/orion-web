/**
 * Sensitive data redaction for logging.
 * SOC2: [M-004] Prevents sensitive data (tokens, keys, passwords) from being logged in plaintext.
 */

// Patterns that indicate sensitive data — order matters (longer patterns first)
const SENSITIVE_PATTERNS = [
  /(?:orion_ak_[a-zA-Z0-9]{36})/g,             // API keys (orion_ak_ + 36 hex chars)
  /(?:Bearer\s+[a-zA-Z0-9._-]+)/gi,            // Bearer tokens
  /(?:password(?:Hash)?["\s:=]+)["']?[^"'\s,}\]]+/gi,  // password=password_hash
  /(?:token|secret|apiKey|kubeconfig|gatewayToken)["\s:=]+["']?[^"'\s,}\]]+/gi,  // key=value pairs
  /(?:eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+)/g,  // JWT tokens
  /(?:mcg_[a-f0-9]{64})/g,                     // Gateway join tokens
  /(?:setup\.token["\s:=]+)["']?([a-f0-9]{64})/gi,  // Setup tokens
  /(?:GATEWAY_TOKEN|NEXTAUTH_SECRET|ORION_ENCRYPTION_KEY)["\s:=]+["']?[^"'\s,}\]]+/gi,  // Known secret env vars
] as const

/**
 * Redact sensitive data from a string for safe logging.
 * Preserves the first/last 4 chars of values to maintain log readability.
 */
export function redactSensitive(input: string): string {
  let result = input
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match, ...captureGroups) => {
      // Check if any capture group contains a token-like value
      for (const group of captureGroups) {
        if (group && typeof group === 'string' && group.length > 8) {
          // Preserve first 4 and last 4 chars for log readability
          const masked = group.slice(0, 4) + '*'.repeat(group.length - 8) + group.slice(-4)
          // Replace only this occurrence
          const escaped = pattern.source.replace(/\(\\?:.*?\)/, `\\(?:${group.slice(0, 4)}[^\\]]*`)
          return match.replace(group, masked)
        }
      }
      // Full match — mask it
      return '***REDACTED***'
    })
  }
  return result
}

/**
 * Wrap console.log to automatically redact sensitive data from all arguments.
 * Usage: const log = makeRedactedLog('[my-module]')
 */
export function makeRedactedLog(prefix: string) {
  return (...args: unknown[]) => {
    const redacted = args.map(arg => {
      if (typeof arg === 'string') return redactSensitive(arg)
      if (arg && typeof arg === 'object') {
        try {
          return JSON.stringify(arg, (_key, value) => {
            if (typeof value === 'string') return redactSensitive(value)
            return value
          }, 2)
        } catch {
          return String(arg)
        }
      }
      return arg
    })
    console.log(`${prefix} ${redacted.join(' ')}`)
  }
}

/**
 * Redact arguments and call the original console method.
 */
function redactAndLog(originalMethod: (...args: unknown[]) => void, args: unknown[]): void {
  const redacted = args.map(arg => {
    if (typeof arg === 'string') return redactSensitive(arg)
    if (arg && typeof arg === 'object') {
      try {
        return JSON.stringify(arg, (_key, value) => {
          if (typeof value === 'string') return redactSensitive(value)
          return value
        }, 2)
      } catch {
        return String(arg)
      }
    }
    return arg
  })
  originalMethod(...redacted)
}

/**
 * Wrap global console methods (log, error, warn, info, debug) to automatically redact all output.
 * Call this once at application startup.
 * SOC2: [K8S-001] Prevents secrets from leaking via any console output channel.
 */
let wrapped = false
export function wrapConsoleLog(): void {
  if (wrapped) return
  wrapped = true

  // Preserve originals before wrapping
  const originalLog = console.log.bind(console)
  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalInfo = console.info.bind(console)
  const originalDebug = console.debug.bind(console)

  // Wrap each method
  console.log = function (...args: unknown[]) {
    redactAndLog(originalLog, args)
  }
  console.error = function (...args: unknown[]) {
    redactAndLog(originalError, args)
  }
  console.warn = function (...args: unknown[]) {
    redactAndLog(originalWarn, args)
  }
  console.info = function (...args: unknown[]) {
    redactAndLog(originalInfo, args)
  }
  console.debug = function (...args: unknown[]) {
    redactAndLog(originalDebug, args)
  }
}

/**
 * ─── FIELD-LEVEL REDACTION (for #186) ────────────────────────────────────
 * Complements regex redaction with explicit field-level stripping
 * for known secret columns
 */

export interface SafeObject {
  [key: string]: unknown
}

/**
 * Redact sensitive fields in an object.
 * Used for known secret columns: apiKey, gatewayToken, kubeconfig, passwordHash
 */
export function redactObjectFields<T extends SafeObject>(obj: T, fieldsToRedact: string[] = [
  'apiKey',
  'gatewayToken',
  'kubeconfig',
  'passwordHash',
  'apiSecret',
  'webhookSecret',
  'privateKey',
]): T {
  const redacted = JSON.parse(JSON.stringify(obj)) as T

  for (const field of fieldsToRedact) {
    if (field in redacted) {
      (redacted as any)[field] = '[REDACTED]'
    }
  }

  return redacted
}

/**
 * Recursively redact sensitive fields in nested objects/arrays.
 * Performs deep walk of JSON structure.
 */
export function redactNestedFields(
  value: unknown,
  fieldsToRedact: string[] = [
    'apiKey',
    'gatewayToken',
    'kubeconfig',
    'passwordHash',
    'apiSecret',
    'webhookSecret',
    'privateKey',
  ]
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => redactNestedFields(item, fieldsToRedact))
  }

  const obj = value as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(obj)) {
    if (fieldsToRedact.includes(key)) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactNestedFields(val, fieldsToRedact)
    }
  }

  return result
}

/**
 * JSON replacer function for use with JSON.stringify
 * Redacts sensitive fields during serialization
 */
export function createRedactionReplacer(
  fieldsToRedact: string[] = [
    'apiKey',
    'gatewayToken',
    'kubeconfig',
    'passwordHash',
    'apiSecret',
    'webhookSecret',
    'privateKey',
  ]
) {
  return (_key: string, value: unknown) => {
    if (_key && fieldsToRedact.includes(_key)) {
      return '[REDACTED]'
    }
    return value
  }
}

/**
 * Safe stringify: Redacts sensitive fields before JSON encoding
 */
export function safeStringify(obj: unknown): string {
  const fieldsToRedact = [
    'apiKey',
    'gatewayToken',
    'kubeconfig',
    'passwordHash',
    'apiSecret',
    'webhookSecret',
    'privateKey',
  ]
  return JSON.stringify(obj, createRedactionReplacer(fieldsToRedact))
}
