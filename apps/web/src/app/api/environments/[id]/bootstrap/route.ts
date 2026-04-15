/**
 * POST /api/environments/:id/bootstrap
 *
 * Triggers cluster bootstrap: Gitea repo + ArgoCD + Gateway.
 * Returns a Server-Sent Events stream so the UI can show live progress.
 */
import { NextRequest } from 'next/server'
import { bootstrapCluster, type BootstrapEvent } from '@/lib/cluster-bootstrap'

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: BootstrapEvent) {
        const data = `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(data))
      }

      try {
        await bootstrapCluster(params.id, send)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[bootstrap] ${params.id} failed:`, err)
        send({ type: 'error', message: msg })
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
