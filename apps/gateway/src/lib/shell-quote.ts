/**
 * Shell argument quoting — prevents shell injection in tool execution.
 *
 * SOC2: [H-005] Replaces the previous regex blocklist approach.
 * By properly quoting each argument in single quotes (with internal single
 * quotes escaped as '\'''), injection is impossible regardless of content.
 */

/**
 * Quote a single argument for safe use in shell -c commands.
 * Wraps in single quotes; internal single quotes are escaped.
 *
 * Example:  quote("hello 'world'") → "hello '\''world'\''"
 *
 * This is safe because:
 * - Single quotes preserve everything literally in POSIX shells
 * - The '\'' technique ends the current quote, inserts a literal '
 *   via double-quoted string, then starts a new single quote
 */
export function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * Validate that a string is a valid Alpine package name.
 * SOC2: [H-006] Prevents package name injection via tool definitions.
 *
 * Alpine package names: start with letter, contain only [a-zA-Z0-9._+-]
 * Max 127 characters. No special characters, no path traversal, no injection.
 */
export const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9._+-]*$/

export function validatePackageName(name: string): boolean {
  if (!name) return false
  if (name.length > 127) return false
  return PACKAGE_NAME_RE.test(name)
}
