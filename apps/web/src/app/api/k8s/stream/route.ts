import { createSSEStream } from '@/lib/sse'
import { addSseClient, removeSseClient, getCache, startWatchers } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// SOC2: [CR-003] No authentication — unauthenticated access to real-time K8s events.
// Remediation: Add requireAuth() check; verify user has access to requested cluster/namespaces.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) throw new Response('Unauthorized', { status: 401 })

  await startWatchers()

  return createSSEStream((send, close) => {
    // Send initial state
    const { pods, nodes } = getCache()
    send('init', { pods, nodes })

    const client = {
      write: (data: string) => {
        // Parse the SSE data and re-send through our helper
        const lines = data.split('\n')
        const eventLine = lines.find(l => l.startsWith('event:'))
        const dataLine  = lines.find(l => l.startsWith('data:'))
        if (eventLine && dataLine) {
          const event = eventLine.replace('event: ', '')
          const payload = JSON.parse(dataLine.replace('data: ', ''))
          send(event, payload)
        }
      },
      close,
    }

    addSseClient(client)
    return () => removeSseClient(client)
  })
}
