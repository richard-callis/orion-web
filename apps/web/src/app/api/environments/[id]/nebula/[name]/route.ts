import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/[name]
 * Get a specific nebula instance by name.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string; name: string } }
) {
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
  })
  if (!entry) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(entry)
}

/**
 * PUT /api/environments/[id]/nebula/[name]
 * Update or fork a nebula entry (operator+ or admin).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const isAdmin = req.headers.get('x-admin') === 'true'
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  const body = await req.json()
  const existing = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const entry = await prisma.nebulaInstance.update({
    where: { id: existing.id },
    data: { ...body, isForked: true },
  })
  return NextResponse.json(entry)
}

/**
 * DELETE /api/environments/[id]/nebula/[name]
 * Remove a nebula entry from this environment (operator+ or admin).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; name: string } }
) {
  const isAdmin = _req.headers.get('x-admin') === 'true'
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  await prisma.nebulaInstance.deleteMany({
    where: { environmentId: params.id, name: params.name },
  })
  return NextResponse.json({ ok: true })
}
