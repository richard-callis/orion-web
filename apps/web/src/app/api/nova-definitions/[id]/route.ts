import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nova-definitions/[id]
 * Get definition details by ID.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // MAJOR fix: GET had no auth — any logged-in user could read nova definition specs
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const nova = await prisma.novaDefinition.findUnique({
    where: { id: (await params).id },
  })
  if (!nova) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(nova)
}

/**
 * PUT /api/nova-definitions/[id]
 * Update a Nova definition (admin only).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  // MAJOR fix: raw body was written directly to Prisma (mass assignment)
  const title       = body.title ? String(body.title).slice(0, 200) : undefined
  const category    = body.category === 'skill' || body.category === 'hook' ? body.category : undefined
  const spec        = body.spec !== undefined ? (typeof body.spec === 'string' ? body.spec : JSON.stringify(body.spec)) : undefined
  const description = body.description ? String(body.description).slice(0, 2000) : undefined
  const version     = body.version ? String(body.version).slice(0, 50) : undefined
  const metadata    = body.metadata !== undefined ? (typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata)) : undefined

  const updateData: Record<string, unknown> = {}
  if (title !== undefined)       updateData.title = title
  if (category !== undefined)    updateData.category = category
  if (spec !== undefined)        updateData.spec = spec
  if (description !== undefined) updateData.description = description
  if (version !== undefined)     updateData.version = version
  if (metadata !== undefined)    updateData.metadata = metadata

  const nova = await prisma.novaDefinition.update({
    where: { id: (await params).id },
    data: updateData,
  })
  return NextResponse.json(nova)
}

/**
 * DELETE /api/nova-definitions/[id]
 * Delete a Nova definition (admin only). Fails with 409 if it has instances.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  // Check for instances
  const instances = await prisma.nebulaInstance.findFirst({
    where: { sourceNovaId: (await params).id },
  })
  if (instances) {
    return NextResponse.json(
      { error: 'Cannot delete — has instances' },
      { status: 409 }
    )
  }
  await prisma.novaDefinition.delete({ where: { id: (await params).id } })
  return NextResponse.json({ ok: true })
}
