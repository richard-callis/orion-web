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
