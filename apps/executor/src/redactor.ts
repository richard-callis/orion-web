class Redactor {
  private secretPatterns = [
    /PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH/i,
    /-----BEGIN.*PRIVATE KEY-----/,
    /eyJ[a-zA-Z0-9_-]{10,}/,  // JWT
  ]

  redactArgs(args: Record<string, unknown>): Record<string, unknown> {
    return this.redactObject(args)
  }

  redactOutput(output: string): string {
    let redacted = output

    // Redact env var names
    redacted = redacted.replace(
      /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH)=\S+/gi,
      '$1=[REDACTED]'
    )

    // Redact hex strings >40 chars adjacent to secret keywords
    redacted = redacted.replace(
      /((?:password|secret|token|key|credential|api_key|private_key|auth)[=:\s]+)([a-f0-9]{40,})/gi,
      '$1[REDACTED]'
    )

    // Redact JWT-like strings
    redacted = redacted.replace(
      /eyJ[a-zA-Z0-9_-]{50,}/g,
      '[REDACTED]'
    )

    // Redact PEM blocks
    redacted = redacted.replace(
      /-----BEGIN.*?KEY-----[\s\S]*?-----END.*?KEY-----/g,
      '[REDACTED]'
    )

    return redacted
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(obj)) {
      if (this.isSecretKey(key)) {
        result[key] = '[REDACTED]'
      } else if (typeof value === 'string') {
        result[key] = this.redactString(value)
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.redactObject(value as Record<string, unknown>)
      } else {
        result[key] = value
      }
    }

    return result
  }

  private isSecretKey(key: string): boolean {
    return this.secretPatterns.some(pattern => pattern.test(key))
  }

  private redactString(str: string): string {
    // Check if string looks like a secret
    if (str.length > 20 && /^[a-f0-9]{40,}$/.test(str)) {
      return '[REDACTED]'
    }
    if (/^eyJ[a-zA-Z0-9_-]{10,}/.test(str)) {
      return '[REDACTED]'
    }
    if (/-----BEGIN.*PRIVATE KEY-----/.test(str)) {
      return '[REDACTED]'
    }
    return str
  }
}

export const redactor = new Redactor()
