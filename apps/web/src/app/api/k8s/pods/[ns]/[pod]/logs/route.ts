import { NextRequest } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { coreApi } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { ns: string; pod: string } }
) {
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
