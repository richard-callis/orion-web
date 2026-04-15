export const dynamic = 'force-dynamic'

/**
 * PATCH /api/environments/:id/credentials
 *
 * Saves cluster credential fields inline from the bootstrap modal.
 * Supports: nodeIp (stored in metadata), talosconfig (stored in metadata,
 * base64-encoded), kubeconfig (stored directly on the model, base64-encoded).
 *
 * Only fields present in the request body are updated.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json() as {
    nodeIp?:      string
    talosconfig?: string   // base64-encoded talosconfig YAML
    kubeconfig?:  string   // base64-encoded kubeconfig YAML
  }

  const currentMeta = (env.metadata ?? {}) as Record<string, unknown>
  const metaUpdate: Record<string, unknown> = { ...currentMeta }

  if (body.nodeIp !== undefined) {
    metaUpdate.nodeIp = body.nodeIp.trim() || undefined
  }
  if (body.talosconfig !== undefined) {
    metaUpdate.talosconfig = body.talosconfig.trim() || undefined
  }

  const data: Record<string, unknown> = { metadata: metaUpdate }
  if (body.kubeconfig !== undefined) {
    data.kubeconfig = body.kubeconfig.trim() || null
  }

  await prisma.environment.update({ where: { id: params.id }, data })
  return NextResponse.json({ ok: true })
}
