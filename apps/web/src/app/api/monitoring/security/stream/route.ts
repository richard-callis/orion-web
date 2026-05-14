import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest): Promise<Response> {
  const { signal } = request

  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(`\n\n: connected\n\n`)

      const interval = setInterval(() => {
        controller.enqueue(`: heartbeat\n\n`)
      }, 15000)

      signal.addEventListener('abort', () => {
        clearInterval(interval)
        controller.close()
      })

      // Poll for new events every 5 seconds
      const pollInterval = setInterval(async () => {
        try {
          const { prisma } = await import('@/lib/db')
          const events = await prisma.securityEvent.findMany({
            where: { acknowledged: false },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })

          if (events.length > 0) {
            controller.enqueue(`data: ${JSON.stringify(events)}\n\n`)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'poll error'
          controller.enqueue(`data: {"error":"${msg}"}\n\n`)
        }
      }, 5000)

      signal.addEventListener('abort', () => {
        clearInterval(interval)
        clearInterval(pollInterval)
      })
    },
  })

  return new Response(stream, { headers })
}
