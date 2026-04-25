import { NextRequest, NextResponse } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { coreApi } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'
import { redactSensitive } from '@/lib/redact'

// SOC2: CR-003 — K8s pod logs may contain secrets/tokens in environment variables,
// mounted secrets, and application output. Redact before returning to user.
const K8S_LOG_PATTERNS = [
  // Common env var patterns that hold secrets
  /(?:AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|DB_PASSWORD|MYSQL_ROOT_PASSWORD|POSTGRES_PASSWORD|REDIS_URL|REDIS_PASSWORD|MONGO_URL|MONGODB_URI|MONGO_PASSWORD)["\s:=]+["']?([^"'\'\s,}\]][^\s,}"]*)/gi,

  // Generic secret-like env vars
  /(?:STRIPE_SECRET_KEY|SLACK_WEBHOOK_SECRET|SENDGRID_API_KEY|SPARKPOST_API_KEY)["\s:=]+["']?([^"'\'\s,}\]][^\s,}"]*)/gi,

  // Vault tokens (vault: prefix or hvs. prefix)
  /(?:vault:\s*)[a-zA-Z0-9_-]+/gi,
  /hvs\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
] as const

/**
 * Redact sensitive data from K8s pod log lines.
 * SOC2: CR-003 — prevents secrets/tokens from leaking in pod logs returned to users.
 */
export function redactPodLogLine(line: string): string {
  let result = line

  // Apply existing general-purpose redaction (catches Bearer tokens, JWTs, orion_ak_, mcg_, etc.)
  result = redactSensitive(result)

  // Apply K8s-specific patterns for secret env vars
  for (const pattern of K8S_LOG_PATTERNS) {
    result = result.replace(pattern, (match, value) => {
      if (value && value.length > 8) {
        const masked = value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4)
        return match.replace(value, masked)
      }
      return match
    })
  }

  return result
}

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { ns: string; pod: string } }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return createSSEStream((send, close) => {
    ;(async () => {
      try {
        // v0.22: readNamespacedPodLog(name, ns, container, follow, insecureSkipTLS, limitBytes, pretty, previous, sinceSeconds, sinceTime, tailLines, timestamps)
        const res = await coreApi.readNamespacedPodLog(
          params.pod,
          params.ns,
          undefined,   // container
          false,       // follow
          undefined,   // insecureSkipTLSVerifyBackend
          undefined,   // limitBytes
          undefined,   // pretty
          false,       // previous
          undefined,   // sinceSeconds
          undefined,   // sinceTime (Date)
          200,         // tailLines
          false        // timestamps
        )
        const text: string = typeof res === 'string' ? res : (res.body ?? '')
        for (const line of text.split('\n')) {
          if (line) send('message', redactPodLogLine(line))
        }
        close()
      } catch (err) {
        send('error', String(err))
        close()
      }
    })()
    return () => {}
  })
}
