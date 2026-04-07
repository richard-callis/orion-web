import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  const updateData: Record<string, unknown> = {}
  if (body.role   !== undefined) updateData.role   = body.role
  if (body.active !== undefined) updateData.active = body.active

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
  })
  return NextResponse.json(user)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.user.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
