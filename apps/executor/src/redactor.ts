const REDACTED = '[REDACTED]'

// Ordered replacements applied to any free text (command output and string args). The early
// rules keep the key and mask the value; the later ones catch secrets that appear bare, with no
// telltale KEY= in front — e.g. a token printed by `grep -o` or read from /proc/<pid>/environ.
const TEXT_RULES: Array<[RegExp, string]> = [
  // PEM private keys
  [/-----BEGIN[^-]*KEY-----[\s\S]*?-----END[^-]*KEY-----/g, REDACTED],
  // KEY=value / KEY: value for secret-looking names (ORION_GATEWAY_TOKEN=..., "password": "...")
  // (`KEY` only counts as a whole word or after `_`, so `monkey: 1` and `Author:` are left alone.)
  [/(\b[A-Z0-9_]*?(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|APIKEY|(?:\b|_)KEY)[A-Z0-9_]*["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, `$1${REDACTED}`],
  // HTTP auth headers
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Credentials embedded in URLs
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // JWTs (header.payload[.signature])
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, REDACTED],
  // Bare JWT-ish blobs without dots
  [/\beyJ[A-Za-z0-9_-]{30,}/g, REDACTED],
  // Well-known token formats
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bhv[sbr]\.[A-Za-z0-9_-]{20,}\b/g, REDACTED], // Vault tokens
  // Long bare hex (>=48 chars: covers 32-byte hex secrets but leaves 40-char git SHAs alone).
  // Content digests written as sha256:/sha512: are left readable.
  [/(?<![A-Za-z0-9:])(?<!sha(?:256|512):)[a-fA-F0-9]{48,}(?![A-Za-z0-9])/g, REDACTED],
  // Long bare base64/base64url with mixed case and a digit — random tokens, not words or paths.
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*[0-9])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_=-])/g, REDACTED],
]

const SECRET_KEY = /PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|APIKEY|(?:^|_)KEY$|^AUTH(?:ORIZATION)?$/i

export class Redactor {
  redactArgs(args: Record<string, unknown>): Record<string, unknown> {
    return this.redactObject(args)
  }

  redactOutput(output: string): string {
    let redacted = output
    for (const [pattern, replacement] of TEXT_RULES) {
      redacted = redacted.replace(pattern, replacement)
    }
    return redacted
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactOutput(value)
    if (Array.isArray(value)) return value.map(v => this.redactValue(v))
    if (typeof value === 'object' && value !== null) return this.redactObject(value as Record<string, unknown>)
    return value
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = SECRET_KEY.test(key) ? REDACTED : this.redactValue(value)
    }
    return result
  }
}

export const redactor = new Redactor()
