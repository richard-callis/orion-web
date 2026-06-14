import { NextRequest, NextResponse } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { coreApi } from '@/lib/k8s'
import { requireAdmin } from '@/lib/auth'
import { redactSensitive } from '@/lib/redact'

export const dynamic = 'force-dynamic'

// SOC2: CR-003 — pod logs are admin-only (vault-namespace logs contain secrets/tokens)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ns: string; pod: string }> }
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Validate namespace and pod name as DNS-1123 labels to prevent
  // path-based enumeration of the API server
  const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  if (!DNS_LABEL.test((await params).ns) || !DNS_LABEL.test((await params).pod)) {
    return NextResponse.json({ error: 'Invalid namespace or pod name' }, { status: 400 })
  }

  return createSSEStream((send, close) => {
    ;(async () => {
      try {
        // v0.22: readNamespacedPodLog(name, ns, container, follow, insecureSkipTLS, limitBytes, pretty, previous, sinceSeconds, sinceTime, tailLines, timestamps)
        const res = await coreApi.readNamespacedPodLog(
          (await params).pod,
          (await params).ns,
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
          if (line) send('message', redactSensitive(line))
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
