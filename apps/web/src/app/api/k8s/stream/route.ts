import { NextResponse } from 'next/server'
import { createSSEStream } from '@/lib/sse'
import { addSseClient, removeSseClient, getCache, startWatchers } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// SOC2: CR-003 — K8s events exposed real-time without authentication
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
