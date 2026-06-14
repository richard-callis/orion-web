/**
 * POST /api/environments/:id/deploy-gateway
 *
 * Full bootstrap for localhost/docker environments:
 *   1. Deploy gateway container
 *   2. Create Gitea repo + scaffold + webhook
 *   3. Register Gitea Actions runner
 *
 * Returns an SSE stream with live progress.
 */
import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { bootstrapLocalEnvironment, type LocalBootstrapEvent } from '@/lib/localhost-bootstrap'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: LocalBootstrapEvent) {
        const data = `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(data))
      }

      try {
        await bootstrapLocalEnvironment((await params).id, send)
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
