import { createSSEStream } from '@/lib/sse'
import { addSseClient, removeSseClient, getCache, startWatchers } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export async function GET() {
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
