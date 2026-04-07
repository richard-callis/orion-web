import { NextResponse } from 'next/server'

export function createSSEStream(
  handler: (send: (event: string, data: unknown) => void, close: () => void) => () => void
): NextResponse {
  let closed = false
  let cleanup: (() => void) | undefined

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\nretry: 3000\n\n`))
      }

      const close = () => {
        closed = true
        try { controller.close() } catch {}
        cleanup?.()
      }

      cleanup = handler(send, close)
    },
    cancel() {
      closed = true
      cleanup?.()
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx/Traefik buffering
    },
  })
}
