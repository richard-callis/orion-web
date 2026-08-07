// Allowed shell commands per environment type (allowlist)
export const ALLOWED_COMMAND_PREFIXES = {
  cluster: [
    'kubectl', 'helm', 'kubectl-kustomize', 'kubens', 'kubectx',
  ],
  docker: [
    'docker', 'docker-compose', 'docker compose', 'ctr', 'nerdctl',
  ],
  localhost: [
    'kubectl', 'helm', 'docker', 'docker-compose', 'docker compose',
    'sh', 'bash', 'curl', 'wget', 'jq', 'yq', 'tar', 'gzip', 'gunzip',
    'grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'cat',
    'ls', 'find', 'df', 'du', 'free', 'top', 'ps', 'uptime', 'hostname',
    'ip', 'ifconfig', 'ss', 'nc', 'ncat', 'nmap', 'ping', 'traceroute',
    'dig', 'nslookup', 'host', 'systemctl', 'journalctl', 'chmod', 'chown',
    'mkdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'zip', 'unzip', 'rsync',
    'apt-get', 'apk', 'yum', 'dnf', 'pip', 'npm', 'yarn', 'pnpm',
  ],
  generic: [
    'sh', 'bash', 'curl', 'wget', 'jq', 'yq', 'grep', 'sed', 'awk',
    'ls', 'find', 'cat', 'echo', 'test', '[', 'true', 'false',
  ],
} as const

// Read-only text-processing filters allowed in any pipe segment *after* the first, regardless of
// environment type — e.g. `kubectl get pods -o json | jq .` under a `cluster` env, where `jq` isn't
// (and shouldn't be) in the cluster allowlist itself. Only the first segment has to prove it's an
// environment-appropriate command; everything piped after it only has to prove it's a safe filter.
const STREAM_FILTER_COMMANDS = [
  'jq', 'yq', 'grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'cat', 'cut', 'tr', 'column',
] as const

// Block common injection patterns even if individual chars are "safe"
const DANGEROUS_PATTERNS = [
  /\|\|/,      // OR chain
  /&&/,        // AND chain
  /(?<!&)&(?!&)/, // single ampersand (background execution / separator)
  /[\r\n]/,    // newline/CR — never legitimate in a single generated command
  /\$\(/,      // command substitution
  /`[^`]*`/,   // backtick substitution
  /;/,         // semicolon — command separator (bare, not just ";" + word: a non-word first
               // byte after ";" like "; 'wget' ..." or "; (curl ...)" previously slipped through)
  />[ \t]*/,   // output redirect
  /<([ \t]|&)/, // input redirect
  /\/etc\//,   // reading system files
  /\/proc\//,  // proc filesystem
  /\/dev\//,   // device files
  /rm\s+-rf/,  // mass deletion
  /dd\s+/,     // disk operations
  /mknod/,     // device creation
  /mkfifo/,    // named pipe creation
  /socat/,     // network utility (common in reverse shells)
  /nc\s+(-[elp]|-[lv]|-[c])/, // netcat patterns
  /python.{0,200}-c/, // python -c code execution — bounded quantifier: an unbounded `.*` here is
  /perl.{0,200}-e/,   // O(n) per failed match attempt at every scan position, which is effectively
  /ruby.{0,200}-e/,   // quadratic against a long enough command (measured multi-second stalls on a
  /node.{0,200}-e/,   // few hundred KB of input); 200 chars is far more than any real invocation needs
  /base64\s+-d/, // base64 decode
  /\bxargs\b/, // xargs (often used in chains)
]

function isAllowedFirstWord(segment: string, allowed: readonly string[]): boolean {
  const words = segment.trim().split(/\s+/)
  const first = words[0] ?? ''
  return allowed.some(prefix => {
    if (prefix.includes(' ')) {
      // multi-word allowlist entry (e.g. "docker compose") — every word must match exactly, in order
      const prefixWords = prefix.split(' ')
      return prefixWords.every((w, i) => words[i] === w)
    }
    // exact match only — NOT startsWith, so `sh` cannot admit `shred`/`shutdown`, `nc` cannot admit `ncat`-as-substring, etc.
    return first === prefix
  })
}

/**
 * Sanitize a generated shell command — strip dangerous patterns.
 * Returns sanitized command or throws if it contains untrusted patterns.
 *
 * A single generated command may legitimately be a pipeline (e.g. `kubectl get pods -o json | jq .`),
 * so every `|`-separated segment is validated independently — the FIRST segment must be an
 * environment-appropriate command (the env-specific allowlist), and every segment AFTER the first
 * must be a safe read-only stream filter (STREAM_FILTER_COMMANDS), regardless of environment type.
 * Checking only the first segment would let a disallowed/dangerous command hide behind a pipe.
 */
const MAX_COMMAND_LENGTH = 2000

export function sanitizeCommand(command: string, envType: string): string {
  const trimmed = command.trim()

  // Belt-and-suspenders alongside the bounded quantifiers above: no legitimate generated tool
  // command is anywhere near this long, and capping it bounds the worst case for every pattern
  // below regardless of how it's written.
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Generated command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters`)
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`Generated command contains unsafe pattern: ${trimmed.slice(0, 80)}`)
    }
  }

  const allowed = ALLOWED_COMMAND_PREFIXES[envType as keyof typeof ALLOWED_COMMAND_PREFIXES]
    ?? ALLOWED_COMMAND_PREFIXES.generic // unknown/unrecognized envType falls back to the most restrictive list, not an unchecked pass-through

  const segments = trimmed.split('|').map(s => s.trim()).filter(Boolean)
  segments.forEach((segment, i) => {
    const segmentAllowlist = i === 0 ? allowed : STREAM_FILTER_COMMANDS
    if (!isAllowedFirstWord(segment, segmentAllowlist)) {
      const firstWord = segment.split(/\s+/)[0] ?? ''
      const context = i === 0 ? `'${envType}' environment` : 'a piped segment (only read-only filters allowed after the first command)'
      throw new Error(`Command '${firstWord}' not allowed in ${context}. Allowed: ${segmentAllowlist.join(', ')}`)
    }
  })

  return trimmed
}
