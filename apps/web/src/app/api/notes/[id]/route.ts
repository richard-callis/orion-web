import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const note = await prisma.note.findUnique({ where: { id: params.id } })
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(note)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.title   !== undefined) data.title   = body.title
  if (body.content !== undefined) data.content = body.content
  if (body.folder  !== undefined) data.folder  = body.folder
  if (body.pinned  !== undefined) data.pinned  = body.pinned
  if (body.type    !== undefined) data.type    = body.type
  if (body.tags    !== undefined) data.tags    = body.tags || null
  const note = await prisma.note.update({ where: { id: params.id }, data })
  return NextResponse.json(note)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.note.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
