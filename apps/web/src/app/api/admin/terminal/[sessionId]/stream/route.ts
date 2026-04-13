export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { subscribeToSession, unsubscribeFromSession, sessionExists } from '@/lib/terminal-sessions'
import { randomBytes } from 'crypto'

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  console.log('[terminal] SSE connect request for session', params.sessionId, 'exists:', sessionExists(params.sessionId))
  if (!sessionExists(params.sessionId)) {
    console.log('[terminal] SSE 404 - session not found', params.sessionId)
    return new Response('session not found', { status: 404 })
  }

  const subscriberId = randomBytes(8).toString('hex')
  const encoder      = new TextEncoder()

  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      console.log('[terminal] SSE stream start for session', params.sessionId)

      const ping = () => {
        try { controller.enqueue(encoder.encode(': ping\n\n')) } catch { /* closed */ }
      }

      const send = (raw: string) => {
        // node-pty gives us a UTF-8 string; base64-encode to safely carry through SSE
        const b64 = Buffer.from(raw, 'utf8').toString('base64')
        try {
          controller.enqueue(encoder.encode(`data: ${b64}\n\n`))
        } catch {
          // Controller already closed
        }
      }

      const scrollback = subscribeToSession(params.sessionId, subscriberId, send)
      console.log('[terminal] subscribeToSession result:', scrollback ? `${scrollback.length} scrollback chunks` : 'null (session gone)')
      if (!scrollback) {
        controller.close()
        return
      }

      // Immediate ping so the browser sees data and fires onopen reliably
      ping()

      // Replay scrollback for reconnecting clients
      for (const chunk of scrollback) send(chunk)

      // Keepalive — prevents proxies from closing the idle connection
      heartbeat = setInterval(ping, 15_000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      unsubscribeFromSession(params.sessionId, subscriberId)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
