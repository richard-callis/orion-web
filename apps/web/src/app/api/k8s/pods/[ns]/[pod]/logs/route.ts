import { NextRequest } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { coreApi } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// SOC2: [CR-003] No authentication — unauthenticated access to any pod's logs (may contain secrets/tokens).
// Remediation: Add requireAuth() check; verify user has access to the target namespace.
export async function GET(
  _req: NextRequest,
  { params }: { params: { ns: string; pod: string } }
) {
  const user = await getCurrentUser()
  if (!user) throw new Response('Unauthorized', { status: 401 })

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
          if (line) send('message', line)
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
